const MODULE_NAME = 'vision_char_creator';

const DEFAULT_SYSTEM_PROMPT = `Проанализируй изображение и составь подробную карточку персонажа для ролевой игры в формате SillyTavern:
- Имя (Name)
- Внешность (Appearance: одежда, прическа, черты лица, аксессуары, телосложение)
- Характер (Personality: черты характера, манера речи, повадки)
- Краткая предыстория (Backstory / Scenario)
- Первое сообщение (First Message / Greeting) от лица персонажа.

Верни ответ СТРОГО в формате валидного JSON-объекта без markdown-оберток со следующими ключами:
{
  "name": "Имя персонажа",
  "appearance": "Подробное описание внешности...",
  "personality": "Черты характера, манера речи, повадки...",
  "scenario": "Краткая предыстория и контекст встречи...",
  "first_mes": "Первое сообщение (приветствие) от лица персонажа с действиями в *звездочках* и прямой речью..."
}`;

const CHARACTER_CARD_SCHEMA = {
    name: 'CharacterCardVisionSchema',
    description: 'Структура карточки персонажа SillyTavern по изображению',
    strict: true,
    value: {
        '$schema': 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            name: { type: 'string' },
            appearance: { type: 'string' },
            personality: { type: 'string' },
            scenario: { type: 'string' },
            first_mes: { type: 'string' },
        },
        required: ['name', 'appearance', 'personality', 'scenario', 'first_mes'],
        additionalProperties: false,
    },
};

const defaultSettings = Object.freeze({
    providerMode: 'st_multimodal',
    visionSource: 'openai',
    visionModel: 'gpt-4o',
    ollamaEndpoint: 'http://127.0.0.1:11434',
    interceptAvatarUpload: true,
    showPreviewPopup: true,
    appendPersonalityToDescription: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
});

let cachedImageDataUrl = null;
let isGenerating = false;

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function getStRequestHeaders() {
    const context = SillyTavern.getContext();
    if (typeof context.getRequestHeaders === 'function') {
        return context.getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            reject(new Error('Выбранный файл не является изображением.'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = (err) => reject(new Error(`Ошибка чтения файла: ${err}`));
        reader.readAsDataURL(file);
    });
}

async function extractCurrentAvatarBase64() {
    if (cachedImageDataUrl) return cachedImageDataUrl;

    const avatarInput = document.querySelector('#add_avatar_button');
    if (avatarInput && avatarInput.files && avatarInput.files[0]) {
        cachedImageDataUrl = await fileToDataUrl(avatarInput.files[0]);
        return cachedImageDataUrl;
    }

    const previewImg = document.querySelector('#avatar_load_preview');
    if (!previewImg || !previewImg.src || previewImg.src.includes('img/ai4.png')) {
        return null;
    }
    if (previewImg.src.startsWith('data:image/')) {
        return previewImg.src;
    }
    try {
        const response = await fetch(previewImg.src);
        const blob = await response.blob();
        return await fileToDataUrl(blob);
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Ошибка чтения превью аватара:`, err);
        return null;
    }
}

async function requestVisionCompletion(dataUrl) {
    const settings = getSettings();
    const base64Raw = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    if (settings.providerMode === 'st_multimodal') {
        const response = await fetch('/api/images/caption', {
            method: 'POST',
            headers: getStRequestHeaders(),
            body: JSON.stringify({
                image: dataUrl,
                prompt: settings.systemPrompt,
                api: settings.visionSource,
                model: settings.visionModel,
            }),
        });
        if (!response.ok) {
            throw new Error(`Ошибка Vision API (${response.status}): ${await response.text()}`);
        }
        const data = await response.json();
        if (!data || typeof data.caption !== 'string') {
            throw new Error('Сервер вернул пустой ответ из /api/images/caption.');
        }
        return data.caption;
    }

    if (settings.providerMode === 'st_chat_completion') {
        const messages = [
            { role: 'system', content: 'Отвечай строго валидным JSON.' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: settings.systemPrompt },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            },
        ];
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getStRequestHeaders(),
            body: JSON.stringify({
                messages,
                model: settings.visionModel,
                chat_completion_source: settings.visionSource,
                temperature: 0.7,
                max_tokens: 1500,
                stream: false,
                json_schema: CHARACTER_CARD_SCHEMA,
            }),
        });
        if (!response.ok) {
            throw new Error(`Ошибка Chat Completion API (${response.status}): ${await response.text()}`);
        }
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content ?? data?.content?.[0]?.text ?? data?.response ?? '';
        if (!content) throw new Error('Пустой ответ от Chat Completion API.');
        return content;
    }

    if (settings.providerMode === 'ollama_direct') {
        const endpoint = settings.ollamaEndpoint.replace(/\/+$/, '') + '/api/chat';
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.visionModel || 'llava:latest',
                stream: false,
                format: 'json',
                messages: [{ role: 'user', content: settings.systemPrompt, images: [base64Raw] }],
            }),
        });
        if (!response.ok) {
            throw new Error(`Ошибка Ollama (${response.status}): ${await response.text()}`);
        }
        const data = await response.json();
        return data?.message?.content || '';
    }

    throw new Error(`Неизвестный режим: ${settings.providerMode}`);
}

async function parseCharacterCardResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        throw new Error('Получен пустой ответ от модели.');
    }
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                name: String(parsed.name || parsed.Name || '').trim(),
                appearance: String(parsed.appearance || parsed.Appearance || '').trim(),
                personality: String(parsed.personality || parsed.Personality || '').trim(),
                scenario: String(parsed.scenario || parsed.backstory || parsed.Scenario || '').trim(),
                first_mes: String(parsed.first_mes || parsed.greeting || parsed.firstMessage || '').trim(),
            };
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Ошибка JSON.parse, пробуем парсинг по секциям...`, err);
        }
    }

    const extractSection = (regex) => {
        const match = rawText.match(regex);
        return match ? match[1].trim() : '';
    };

    const fallbackCard = {
        name: extractSection(/(?:Имя|Name)\s*[:\-—]\s*([^\n*#]+)/i),
        appearance: extractSection(/(?:Внешность|Appearance)[^:\n]*[:\-—]\s*([\s\S]*?)(?=\n\s*[-*#]*(?:Характер|Personality|Краткая предыстория|Backstory|Scenario|Первое сообщение|First Message)|$)/i),
        personality: extractSection(/(?:Характер|Personality)[^:\n]*[:\-—]\s*([\s\S]*?)(?=\n\s*[-*#]*(?:Краткая предыстория|Backstory|Scenario|Первое сообщение|First Message)|$)/i),
        scenario: extractSection(/(?:Краткая предыстория|Предыстория|Backstory|Scenario)[^:\n]*[:\-—]\s*([\s\S]*?)(?=\n\s*[-*#]*(?:Первое сообщение|First Message|Greeting)|$)/i),
        first_mes: extractSection(/(?:Первое сообщение|First Message|Greeting)[^:\n]*[:\-—]\s*([\s\S]*?)$/i),
    };

    if (fallbackCard.name || fallbackCard.appearance || fallbackCard.first_mes) {
        return fallbackCard;
    }

    return {
        name: 'Новый Персонаж',
        appearance: rawText.trim(),
        personality: '',
        scenario: '',
        first_mes: '',
    };
}

function applyCardDataToForm(cardData) {
    const settings = getSettings();
    let fullDescription = '';
    if (cardData.appearance) {
        fullDescription += `[Внешность / Appearance]\n${cardData.appearance.trim()}`;
    }
    if (settings.appendPersonalityToDescription && cardData.personality) {
        fullDescription += `${fullDescription ? '\n\n' : ''}[Характер / Personality]\n${cardData.personality.trim()}`;
    }

    const fieldMap = [
        { selector: '#character_name_pole', value: cardData.name },
        { selector: '#description_textarea', value: fullDescription || cardData.appearance },
        { selector: '#personality_textarea', value: cardData.personality },
        { selector: '#scenario_pole', value: cardData.scenario },
        { selector: '#firstmessage_textarea', value: cardData.first_mes },
    ];

    let updatedCount = 0;
    for (const { selector, value } of fieldMap) {
        if (!value) continue;
        const $el = $(selector);
        if ($el.length > 0) {
            $el.val(value).trigger('input').trigger('change');
            updatedCount++;
        }
    }

    if (updatedCount > 0) {
        toastr.success('Поля карточки персонажа заполнены! Не забудьте сохранить карточку.', 'Vision Character Creator');
    } else {
        toastr.warning('Откройте панель создания/редактирования персонажа перед применением.', 'Vision Character Creator');
    }
}

async function showCardPreviewModal(cardData, imageDataUrl) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = SillyTavern.getContext();
    const { DOMPurify } = SillyTavern.libs;
    const escapeHtml = (str) => DOMPurify ? DOMPurify.sanitize(str || '') : String(str || '');

    const htmlContent = `
        <div class="st-vision-preview-box">
            <div class="st-vision-preview-header">
                <img class="st-vision-preview-thumb" src="${imageDataUrl}" alt="Preview" />
                <div>
                    <h3 style="margin: 0 0 4px 0;">Предпросмотр карточки</h3>
                    <small>Проверьте и при необходимости отредактируйте поля перед вставкой.</small>
                </div>
            </div>
            <div class="st-vision-preview-field">
                <label>Имя (Name)</label>
                <input id="st_vision_prev_name" type="text" value="${escapeHtml(cardData.name)}" />
            </div>
            <div class="st-vision-preview-field">
                <label>Внешность (Appearance)</label>
                <textarea id="st_vision_prev_appearance" rows="4">${escapeHtml(cardData.appearance)}</textarea>
            </div>
            <div class="st-vision-preview-field">
                <label>Характер (Personality)</label>
                <textarea id="st_vision_prev_personality" rows="3">${escapeHtml(cardData.personality)}</textarea>
            </div>
            <div class="st-vision-preview-field">
                <label>Краткая предыстория (Scenario)</label>
                <textarea id="st_vision_prev_scenario" rows="3">${escapeHtml(cardData.scenario)}</textarea>
            </div>
            <div class="st-vision-preview-field">
                <label>Первое сообщение (First Message)</label>
                <textarea id="st_vision_prev_first_mes" rows="4">${escapeHtml(cardData.first_mes)}</textarea>
            </div>
        </div>
    `;

    const popup = new Popup(htmlContent, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Применить к карточке',
        cancelButton: 'Отмена',
        allowVerticalScrolling: true,
    });

    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        applyCardDataToForm({
            name: String($('#st_vision_prev_name').val() || '').trim(),
            appearance: String($('#st_vision_prev_appearance').val() || '').trim(),
            personality: String($('#st_vision_prev_personality').val() || '').trim(),
            scenario: String($('#st_vision_prev_scenario').val() || '').trim(),
            first_mes: String($('#st_vision_prev_first_mes').val() || '').trim(),
        });
    }
}

function updateUiLoadingState(loading) {
    const $btns = $('.st-vision-generate-trigger');
    const $status = $('#st_vision_status_indicator');
    if (loading) {
        $btns.addClass('disabled').html('<i class="fa-solid fa-spinner fa-spin"></i> <span>Анализирую изображение...</span>');
        $status.show();
    } else {
        $btns.removeClass('disabled').html('<i class="fa-solid fa-wand-magic-sparkles"></i> <span>Сгенерировать описание по фото</span>');
        $status.hide();
    }
}

async function generateCharacterFromImage(explicitFile = null) {
    if (isGenerating) {
        toastr.info('Генерация уже выполняется, подождите...', 'Vision Character Creator');
        return;
    }
    const { loader } = SillyTavern.getContext();
    const settings = getSettings();
    let loaderHandle = null;

    try {
        let imageDataUrl = explicitFile
            ? await fileToDataUrl(explicitFile)
            : await extractCurrentAvatarBase64();

        if (explicitFile) cachedImageDataUrl = imageDataUrl;

        if (!imageDataUrl) {
            const fileInput = document.getElementById('st_vision_hidden_file_input');
            if (fileInput) fileInput.click();
            else toastr.warning('Сначала выберите фото или загрузите аватар.', 'Vision Character Creator');
            return;
        }

        isGenerating = true;
        updateUiLoadingState(true);

        if (loader && typeof loader.show === 'function') {
            loaderHandle = loader.show({
                blocking: false,
                message: 'Анализирую изображение...',
                title: 'Vision Character Creator',
                toastMode: 'static',
            });
        } else {
            toastr.info('Анализирую изображение...', 'Vision Character Creator', { timeOut: 15000 });
        }

        const rawResponse = await requestVisionCompletion(imageDataUrl);
        const cardData = await parseCharacterCardResponse(rawResponse);

        if (loaderHandle && typeof loaderHandle.hide === 'function') {
            await loaderHandle.hide();
            loaderHandle = null;
        }

        if (settings.showPreviewPopup) {
            await showCardPreviewModal(cardData, imageDataUrl);
        } else {
            applyCardDataToForm(cardData);
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] Ошибка:`, error);
        toastr.error(`Ошибка: ${error.message || error}`, 'Vision Character Creator', { timeOut: 8000 });
    } finally {
        if (loaderHandle && typeof loaderHandle.hide === 'function') {
            await loaderHandle.hide();
        }
        isGenerating = false;
        updateUiLoadingState(false);
    }
}

function mountExtensionUI() {
    const settings = getSettings();
    const { saveSettingsDebounced } = SillyTavern.getContext();

    if ($('#st_vision_hidden_file_input').length === 0) {
        const $hiddenInput = $('<input type="file" id="st_vision_hidden_file_input" accept="image/*" style="display:none;" />');
        $hiddenInput.on('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) {
                const avatarInput = document.querySelector('#add_avatar_button');
                if (avatarInput && (!avatarInput.files || avatarInput.files.length === 0)) {
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    avatarInput.files = dt.files;
                    $(avatarInput).trigger('change');
                }
                await generateCharacterFromImage(file);
                e.target.value = '';
            }
        });
        $('body').append($hiddenInput);
    }

    const $avatarInput = $('#add_avatar_button');
    if ($avatarInput.length > 0 && !$avatarInput.data('st-vision-bound')) {
        $avatarInput.data('st-vision-bound', true);
        $avatarInput.on('change', async function (e) {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                cachedImageDataUrl = await fileToDataUrl(file);
                if (getSettings().interceptAvatarUpload) {
                    toastr.info('Аватар загружен! Нажмите «Сгенерировать описание по фото».', 'Vision Character Creator');
                }
            } catch (err) {
                console.warn(`[${MODULE_NAME}] Ошибка кэширования аватара:`, err);
            }
        });
    }

    if ($('#st_vision_char_editor_btn').length === 0) {
        const $editorBtn = $(`
            <div id="st_vision_editor_container" style="width: 100%; margin: 6px 0;">
                <div id="st_vision_char_editor_btn" class="menu_button st-vision-char-btn st-vision-generate-trigger">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>Сгенерировать описание по фото</span>
                </div>
            </div>
        `);
        $editorBtn.find('#st_vision_char_editor_btn').on('click', () => generateCharacterFromImage(null));
        const $namePole = $('#character_name_pole');
        if ($namePole.length > 0) $namePole.closest('div').before($editorBtn);
        else if ($('#form_create').length > 0) $('#form_create').prepend($editorBtn);
    }

    if ($('#st_vision_extension_settings').length === 0) {
        const settingsHtml = `
            <div id="st_vision_extension_settings" class="extension_container">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>Vision Character Creator (Генератор по фото)</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content" style="display: flex; flex-direction: column; gap: 8px; padding-top: 8px;">
                        <label>Способ подключения к Vision LLM:</label>
                        <select id="st_vision_provider_mode" class="text_pole">
                            <option value="st_multimodal">Встроенный Multimodal Captioning API SillyTavern</option>
                            <option value="st_chat_completion">Активный Chat Completion бэкенд SillyTavern</option>
                            <option value="ollama_direct">Прямое подключение к локальному Ollama (/api/chat)</option>
                        </select>
                        <label>Провайдер Vision API:</label>
                        <select id="st_vision_source" class="text_pole">
                                                        <option value="openai">OpenAI (GPT-4o / GPT-4o-mini)</option>
                            <option value="claude">Anthropic (Claude 3.5 Sonnet)</option>
                            <option value="makersuite">Google Gemini (AI Studio)</option>
                            <option value="openrouter">OpenRouter (Multimodal)</option>
                            <option value="ollama">Ollama (LLaVA / MiniCPM-V)</option>
                            <option value="llamacpp">llama.cpp / KoboldCpp</option>
                        </select>
                        <label>Модель с поддержкой Vision:</label>
                        <input id="st_vision_model" type="text" class="text_pole" />
                        <div id="st_vision_ollama_url_wrap" style="display: none; flex-direction: column; gap: 4px;">
                            <label>URL локального сервера Ollama:</label>
                            <input id="st_vision_ollama_url" type="text" class="text_pole" />
                        </div>
                        <label class="checkbox_label">
                            <input id="st_vision_show_preview" type="checkbox" />
                            <span>Показывать окно предпросмотра перед заполнением полей</span>
                        </label>
                        <label class="checkbox_label">
                            <input id="st_vision_append_pers" type="checkbox" />
                            <span>Объединять Внешность и Характер в поле Description</span>
                        </label>
                        <label>Системный промпт:</label>
                        <textarea id="st_vision_system_prompt" class="text_pole" rows="5"></textarea>
                        <input type="file" id="st_vision_manual_file" accept="image/*" class="text_pole" />
                        <div class="menu_button st-vision-char-btn st-vision-generate-trigger" id="st_vision_settings_gen_btn">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                            <span>Сгенерировать описание по фото</span>
                        </div>
                        <div id="st_vision_status_indicator" class="st-vision-status-bar" style="display: none;">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span>Анализирую изображение...</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        $('#extensions_settings2').append(settingsHtml);

        $('#st_vision_provider_mode').val(settings.providerMode).on('change', function () {
            settings.providerMode = String($(this).val());
            $('#st_vision_ollama_url_wrap').toggle(settings.providerMode === 'ollama_direct');
            saveSettingsDebounced();
        });
        $('#st_vision_ollama_url_wrap').toggle(settings.providerMode === 'ollama_direct');

        $('#st_vision_source').val(settings.visionSource).on('change', function () {
            settings.visionSource = String($(this).val());
            const defaultModels = {
                openai: 'gpt-4o',
                claude: 'claude-3-5-sonnet-latest',
                makersuite: 'gemini-1.5-pro',
                openrouter: 'openai/gpt-4o',
                ollama: 'llava:latest',
                llamacpp: 'minicpm-v',
            };
            if (defaultModels[settings.visionSource]) {
                settings.visionModel = defaultModels[settings.visionSource];
                $('#st_vision_model').val(settings.visionModel);
            }
            saveSettingsDebounced();
        });

        $('#st_vision_model').val(settings.visionModel).on('input', function () {
            settings.visionModel = String($(this).val()).trim();
            saveSettingsDebounced();
        });
        $('#st_vision_ollama_url').val(settings.ollamaEndpoint).on('input', function () {
            settings.ollamaEndpoint = String($(this).val()).trim();
            saveSettingsDebounced();
        });
        $('#st_vision_show_preview').prop('checked', settings.showPreviewPopup).on('change', function () {
            settings.showPreviewPopup = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#st_vision_append_pers').prop('checked', settings.appendPersonalityToDescription).on('change', function () {
            settings.appendPersonalityToDescription = $(this).is(':checked');
            saveSettingsDebounced();
        });
        $('#st_vision_system_prompt').val(settings.systemPrompt).on('input', function () {
            settings.systemPrompt = String($(this).val());
            saveSettingsDebounced();
        });
        $('#st_vision_manual_file').on('change', async function (e) {
            const file = e.target.files?.[0];
            if (file) {
                cachedImageDataUrl = await fileToDataUrl(file);
                toastr.info(`Выбран файл: ${file.name}`, 'Vision Character Creator');
            }
        });
        $('#st_vision_settings_gen_btn').on('click', async () => {
            const manualInput = document.getElementById('st_vision_manual_file');
            await generateCharacterFromImage(manualInput?.files?.[0] || null);
        });
    }
}

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => {
        mountExtensionUI();
        console.log(`[${MODULE_NAME}] Расширение инициализировано.`);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        cachedImageDataUrl = null;
    });
});
