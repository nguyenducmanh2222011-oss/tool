// ==UserScript==
// @name         KAGEVIETSUB Mobile Translator
// @namespace    https://kagevietsub.com/
// @version      1.1.0
// @description  Tự động dịch file phụ đề SRT Trung - Việt bằng DeepSeek trên trình duyệt điện thoại.
// @author       KageVietSub
// @match        https://chat.deepseek.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // 1. CẤU HÌNH & HẰNG SỐ
    // =========================================================================
    const CONFIG = {
        DEFAULT_BATCH_SIZE: 100,       // Mặc định 100 dòng/lô
        MAX_RETRIES: 3,                // Số lần thử lại tối đa cho mỗi đoạn nếu thiếu câu
        POLL_INTERVAL_MS: 800,         // Chu kỳ kiểm tra phản hồi của AI
        STABLE_CHECKS_REQUIRED: 3,     // Số lần nội dung không đổi liên tiếp để xác nhận AI đã hoàn tất
        SAFE_FULL_MODE_ITEMS: 300,     // Ngưỡng cảnh báo số lượng subtitle khi gửi toàn bộ
        SAFE_FULL_MODE_CHARS: 25000,   // Ngưỡng ký tự cảnh báo khi gửi toàn bộ
        STORAGE_KEY: 'kagevietsub_mobile_session',
        CONFIG_KEY_MODE: 'kg_pref_send_mode',
        CONFIG_KEY_BATCH: 'kg_pref_batch_size',
        DEFAULT_PROMPT: `Bạn là công cụ dịch phụ đề Trung → Việt.

Dịch toàn bộ nội dung tiếng Trung sang tiếng Việt.

Input:
#ID Nội dung tiếng Trung

Output:
#ID Nội dung tiếng Việt

Quy tắc:
- Giữ nguyên ID và thứ tự.
- Không bỏ sót, không gộp, không thêm ID.
- Chỉ dịch nội dung sau ID.
- Dịch tự nhiên, phù hợp phụ đề phim/hoạt hình.
- Giữ nhất quán tên nhân vật, địa danh, thuật ngữ và xưng hô.
- Tuyệt đối không trả lại nguyên văn tiếng Trung.
- Không thêm giải thích, Markdown hoặc \`\`\`.
- Chỉ trả về #ID bản dịch.

Dữ liệu cần dịch:`
    };

    // Regex CJK nhận diện chữ Hán
    const CHINESE_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

    // Trạng thái cấu hình người dùng
    let userSettings = {
        mode: 'lines',           // 'lines' (theo số dòng) | 'all' (toàn bộ SRT)
        batchSize: 100           // 20, 50, 100, 200, 300, hoặc tùy chỉnh
    };

    // Trạng thái phiên dịch hiện tại
    let currentSession = {
        fileName: '',
        items: [],          // [{ id, timeline, original, translated, status }]
        isTranslating: false,
        stopRequested: false,
        currentBatchIndex: 0,
        totalBatches: 0
    };

    // =========================================================================
    // 2. LƯU VÀ KHÔI PHỤC CẤU HÌNH (TƯƠNG THÍCH TAMPERMONKEY VÀ USERSCRIPTS IOS)
    // =========================================================================

    function loadUserConfig() {
        let mode = 'lines';
        let batchSize = CONFIG.DEFAULT_BATCH_SIZE;

        try {
            if (typeof GM_getValue === 'function') {
                mode = GM_getValue(CONFIG.CONFIG_KEY_MODE, mode);
                batchSize = Number(GM_getValue(CONFIG.CONFIG_KEY_BATCH, batchSize)) || batchSize;
            } else {
                mode = localStorage.getItem(CONFIG.CONFIG_KEY_MODE) || mode;
                batchSize = Number(localStorage.getItem(CONFIG.CONFIG_KEY_BATCH)) || batchSize;
            }
        } catch (e) {
            try {
                mode = localStorage.getItem(CONFIG.CONFIG_KEY_MODE) || mode;
                batchSize = Number(localStorage.getItem(CONFIG.CONFIG_KEY_BATCH)) || batchSize;
            } catch (err) {}
        }

        userSettings.mode = (mode === 'all' ? 'all' : 'lines');
        userSettings.batchSize = batchSize > 0 ? batchSize : CONFIG.DEFAULT_BATCH_SIZE;
    }

    function saveUserConfig(mode, batchSize) {
        userSettings.mode = mode;
        userSettings.batchSize = batchSize;
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(CONFIG.CONFIG_KEY_MODE, mode);
                GM_setValue(CONFIG.CONFIG_KEY_BATCH, batchSize);
            }
            localStorage.setItem(CONFIG.CONFIG_KEY_MODE, mode);
            localStorage.setItem(CONFIG.CONFIG_KEY_BATCH, String(batchSize));
        } catch (e) {
            try {
                localStorage.setItem(CONFIG.CONFIG_KEY_MODE, mode);
                localStorage.setItem(CONFIG.CONFIG_KEY_BATCH, String(batchSize));
            } catch (err) {}
        }
    }

    // =========================================================================
    // 3. CÔNG CỤ XỬ LÝ SRT & KIỂM TRA CHẤT LƯỢNG (PORT TỪ PYTHON TOOL PC)
    // =========================================================================

    function containsChinese(text) {
        return CHINESE_REGEX.test(text || '');
    }

    function countChinese(text) {
        const matches = (text || '').match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
        return matches ? matches.length : 0;
    }

    function normalizeText(text) {
        return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }

    function isTranslationValid(original, translated) {
        const origClean = normalizeText(original);
        const transClean = normalizeText(translated);

        if (!transClean) {
            return { valid: false, reason: 'Bản dịch rỗng' };
        }

        const origHasChinese = containsChinese(origClean);

        // 1. Kiểm tra nguyên văn không đổi
        if (transClean === origClean) {
            if (origHasChinese) {
                return { valid: false, reason: 'Chưa dịch (nguyên văn tiếng Trung)' };
            }
            // Không có chữ Hán (chỉ số, timeline, ký hiệu) thì giữ nguyên là hợp lệ
            return { valid: true, reason: 'OK' };
        }

        // 2. Kiểm tra còn sót chữ Hán
        if (origHasChinese && containsChinese(transClean)) {
            return { valid: false, reason: 'Còn sót ký tự tiếng Trung' };
        }

        return { valid: true, reason: 'OK' };
    }

    function parseSrtContent(content) {
        const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const blocks = normalized.trim().split(/\n\s*\n/);
        const items = [];
        let autoId = 1;

        for (let i = 0; i < blocks.length; i++) {
            const lines = blocks[i].split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length < 2) continue;

            let timeIdx = 0;
            if (/^\d+$/.test(lines[0]) && lines.length >= 2) {
                timeIdx = 1;
            }

            if (timeIdx >= lines.length) continue;
            const timeline = lines[timeIdx];
            if (!timeline.includes('-->')) continue;

            const textLines = lines.slice(timeIdx + 1);
            const originalText = textLines.join(' ').trim();
            if (!originalText) continue;

            items.push({
                id: autoId,
                timeline: timeline,
                original: originalText,
                translated: null,
                status: 'pending' // pending, translating, translated
            });
            autoId++;
        }

        return items;
    }

    function cleanMarkdown(raw) {
        if (!raw) return '';
        let cleaned = raw.replace(/--&gt;/g, '-->').replace(/-&gt;/g, '->').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
        cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
        cleaned = cleaned.replace(/<[^>]+>/g, '');
        return cleaned;
    }

    function parseAiResponse(rawText, expectedIdSet) {
        const cleaned = cleanMarkdown(rawText);
        const resultMap = {};

        // 1. Phân tích định dạng #ID Nội dung
        const lines = cleaned.split('\n');
        const lineRegex = /^#\s*(\d+)[\s:：.\-]+(.*)$/;

        for (const line of lines) {
            const trimmed = line.trim();
            const match = trimmed.match(lineRegex);
            if (match) {
                const id = parseInt(match[1], 10);
                let content = match[2].trim();
                // Loại bỏ timeline nếu AI lỡ sinh kèm trên cùng dòng
                if (content.includes('-->') || content.includes('->')) {
                    content = content.replace(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*(?:-->|->)\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g, '').trim();
                }
                if (expectedIdSet.has(id) && content) {
                    resultMap[id] = content;
                }
            }
        }

        // 2. Fallback: Nếu AI trả về nguyên khối SRT
        if (Object.keys(resultMap).length === 0 && cleaned.includes('-->')) {
            const srtBlocks = cleaned.split(/\n\s*\n/);
            for (const block of srtBlocks) {
                const bLines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (bLines.length < 2) continue;
                let tIdx = 0;
                let blockId = null;
                const idMatch = bLines[0].match(/#?\s*(\d+)/);
                if (idMatch) {
                    blockId = parseInt(idMatch[1], 10);
                }
                if (bLines.length >= 2 && bLines[1].includes('-->')) {
                    tIdx = 1;
                }
                if (blockId && expectedIdSet.has(blockId) && bLines.length > tIdx + 1) {
                    const trans = bLines.slice(tIdx + 1).join(' ').trim();
                    if (trans) {
                        resultMap[blockId] = trans;
                    }
                }
            }
        }

        return resultMap;
    }

    // =========================================================================
    // 4. TƯƠNG TÁC DOM DEEPSEEK TRÊN MOBILE
    // =========================================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Tìm ô nhập tin nhắn
    function findChatInput() {
        const selectors = [
            'textarea[placeholder*="DeepSeek"]',
            'textarea[placeholder*="Send a message"]',
            'textarea[placeholder*="Nhập tin nhắn"]',
            'textarea#chat-input',
            'textarea',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                return el;
            }
        }
        return null;
    }

    // Nhập nội dung vào textarea/contenteditable và kích hoạt sự kiện cho Vue/React
    function setInputValue(element, text) {
        element.focus();
        if (element.tagName.toLowerCase() === 'textarea') {
            const prototype = Object.getPrototypeOf(element);
            const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (prototypeValueSetter) {
                prototypeValueSetter.call(element, text);
            } else {
                element.value = text;
            }
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else {
            // contenteditable
            element.innerText = text;
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
    }

    // Tìm nút gửi tin nhắn thực tế của DeepSeek (Không dùng Enter trên mobile!)
    function findSendButton() {
        const selectors = [
            'div[role="button"][class*="ds-button--primary"]',
            'div[role="button"].ds-button--primary',
            'div[role="button"][aria-label*="Send"]',
            'div[role="button"][aria-label*="Gửi"]',
            'button[type="submit"]',
            'button[aria-label*="Send"]'
        ];

        for (const sel of selectors) {
            const buttons = document.querySelectorAll(sel);
            if (buttons.length > 0) {
                const lastBtn = buttons[buttons.length - 1];
                if (lastBtn && lastBtn.offsetParent !== null) {
                    const ariaDisabled = lastBtn.getAttribute('aria-disabled');
                    const disabled = lastBtn.hasAttribute('disabled');
                    if (ariaDisabled !== 'true' && !disabled) {
                        return lastBtn;
                    }
                }
            }
        }

        const chatInput = findChatInput();
        if (chatInput) {
            const formContainer = chatInput.closest('form') || chatInput.closest('div[class*="input"]') || chatInput.parentElement?.parentElement;
            if (formContainer) {
                const btn = formContainer.querySelector('div[role="button"]:not([aria-disabled="true"]):has(svg), button:not([disabled]):has(svg)');
                if (btn && btn.offsetParent !== null) {
                    return btn;
                }
            }
        }

        return null;
    }

    function clickButton(btn) {
        if (!btn) return false;
        try {
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            btn.click();
            return true;
        } catch (e) {
            console.warn('[KageVietSub] Lỗi click:', e);
            btn.click();
            return true;
        }
    }

    function isAiGenerating() {
        const allButtons = document.querySelectorAll('div[role="button"], button');
        for (const b of allButtons) {
            const t = (b.innerText || '').trim().toLowerCase();
            if (t === 'stop' || t === 'dừng') {
                if (b.offsetParent !== null) return true;
            }
        }
        return false;
    }

    function isAiThinking() {
        const thinkingEls = document.querySelectorAll('[class*="thinking"], div.thinking-process, div[class*="reasoning"]');
        for (const el of thinkingEls) {
            if (el.offsetParent !== null && !el.classList.contains('completed')) {
                return true;
            }
        }
        return false;
    }

    function checkAndClickContinue() {
        const allButtons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of allButtons) {
            if (btn.offsetParent !== null) {
                const text = (btn.innerText || '').trim();
                if (text === 'Tiếp tục' || text === 'Continue' || text === '继续') {
                    console.log('[KageVietSub] Phát hiện nút Tiếp tục -> Tự động click!');
                    clickButton(btn);
                    return true;
                }
            }
        }
        return false;
    }

    function getLatestAssistantText() {
        const selectors = [
            '.ds-markdown.ds-assistant-message-main-content',
            '.ds-assistant-message-main-content',
            'div[class*="assistant-message"] .ds-markdown',
            'div[class*="assistant-message"]',
            '.ds-markdown'
        ];

        for (const sel of selectors) {
            const list = document.querySelectorAll(sel);
            if (list.length > 0) {
                const last = list[list.length - 1];
                const pre = last.querySelector('pre');
                if (pre && pre.innerText.includes('#')) {
                    return pre.innerText;
                }
                return last.innerText || '';
            }
        }
        return '';
    }

    function getAssistantMessageCount() {
        const list = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content, .ds-assistant-message-main-content');
        return list.length;
    }

    async function createNewChat() {
        const buttons = document.querySelectorAll('div[role="button"], button, a[href="/"]');
        for (const btn of buttons) {
            if (btn.offsetParent !== null) {
                const text = (btn.innerText || '').trim().toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (text.includes('new chat') || text.includes('chat mới') || aria.includes('new chat') || aria.includes('chat mới')) {
                    clickButton(btn);
                    await sleep(1500);
                    return true;
                }
                const svg = btn.querySelector('svg');
                if (svg && svg.getAttribute('viewBox') === '0 0 16 16') {
                    clickButton(btn);
                    await sleep(1500);
                    return true;
                }
            }
        }

        try {
            const homeLink = document.querySelector('a[href="/"]');
            if (homeLink) {
                homeLink.click();
                await sleep(1500);
                return true;
            }
        } catch (e) {
            console.warn('[KageVietSub] Fallback new chat failed:', e);
        }
        return false;
    }

    // =========================================================================
    // 5. TIẾN TRÌNH DỊCH & THEO DÕI PHẢN HỒI
    // =========================================================================

    async function sendMessageAndWaitConfirmation(textToSend, maxWaitMs = 8000) {
        const input = findChatInput();
        if (!input) {
            throw new Error('Không tìm thấy khung nhập tin nhắn của DeepSeek.');
        }

        setInputValue(input, textToSend);
        await sleep(500);

        let sendBtn = null;
        const startFind = Date.now();
        while (Date.now() - startFind < 4000) {
            sendBtn = findSendButton();
            if (sendBtn) break;
            await sleep(200);
        }

        if (!sendBtn) {
            throw new Error('Nút gửi (Send button) chưa sẵn sàng hoặc không tìm thấy.');
        }

        const baselineCount = getAssistantMessageCount();
        clickButton(sendBtn);

        const startConfirm = Date.now();
        while (Date.now() - startConfirm < maxWaitMs) {
            if (currentSession.stopRequested) return false;

            const curInputVal = (input.tagName.toLowerCase() === 'textarea' ? input.value : input.innerText) || '';
            const isGen = isAiGenerating();
            const isThk = isAiThinking();
            const curCount = getAssistantMessageCount();

            if (curCount > baselineCount || isGen || isThk || curInputVal.length === 0) {
                return true;
            }
            await sleep(300);
        }

        return false;
    }

    async function monitorAiResponse(onProgressText, timeoutSec = 300) {
        const startTime = Date.now();
        let lastText = '';
        let stableCount = 0;

        while (Date.now() - startTime < timeoutSec * 1000) {
            if (currentSession.stopRequested) {
                return lastText;
            }

            if (checkAndClickContinue()) {
                stableCount = 0;
                await sleep(1000);
                continue;
            }

            const isGen = isAiGenerating();
            const isThk = isAiThinking();
            const currentText = getLatestAssistantText();

            if (currentText.includes('Length limit reached') || currentText.includes('đã đạt giới hạn độ dài')) {
                throw new Error('DEEPSEEK_LENGTH_LIMIT');
            }

            if (currentText && currentText !== lastText) {
                lastText = currentText;
                stableCount = 0;
                if (onProgressText) onProgressText(currentText);
            } else if (!isGen && !isThk && lastText.length > 0) {
                stableCount++;
                if (stableCount >= CONFIG.STABLE_CHECKS_REQUIRED) {
                    return lastText;
                }
            }

            await sleep(CONFIG.POLL_INTERVAL_MS);
        }

        return lastText;
    }

    async function processBatchWithRetries(batchItems, batchIdx, totalBatches) {
        const expectedIds = batchItems.map(it => it.id);
        const expectedSet = new Set(expectedIds);
        const itemMap = new Map(batchItems.map(it => [it.id, it]));

        updateUIStatus(`Đang dịch đoạn ${batchIdx}/${totalBatches}...`);

        const dataLines = batchItems.map(it => `#${it.id} ${it.original}`).join('\n');
        const initialPrompt = `${CONFIG.DEFAULT_PROMPT}\n\n${dataLines}`;

        const sent = await sendMessageAndWaitConfirmation(initialPrompt);
        if (!sent) {
            throw new Error(`Không thể gửi batch ${batchIdx} vào DeepSeek.`);
        }

        updateUIStatus(`Đang chờ DeepSeek trả lời đoạn ${batchIdx}/${totalBatches}...`);

        let responseText = await monitorAiResponse((text) => {
            const partial = parseAiResponse(text, expectedSet);
            for (const [id, trans] of Object.entries(partial)) {
                const it = itemMap.get(Number(id));
                if (it && isTranslationValid(it.original, trans).valid) {
                    it.translated = trans;
                    it.status = 'translated';
                }
            }
            updateSessionProgress();
        });

        let parsedResults = parseAiResponse(responseText, expectedSet);
        for (const [idStr, trans] of Object.entries(parsedResults)) {
            const id = Number(idStr);
            const it = itemMap.get(id);
            if (it) {
                const check = isTranslationValid(it.original, trans);
                if (check.valid) {
                    it.translated = trans;
                    it.status = 'translated';
                }
            }
        }

        // Retry nếu thiếu dòng
        let retryAttempt = 1;
        while (retryAttempt <= CONFIG.MAX_RETRIES && !currentSession.stopRequested) {
            const missingItems = batchItems.filter(it => !it.translated || it.status !== 'translated');
            if (missingItems.length === 0) {
                break;
            }

            updateUIStatus(`Thiếu ${missingItems.length} câu. Đang xử lý lại (lần ${retryAttempt}/${CONFIG.MAX_RETRIES})...`);
            await sleep(1500);

            const missingLines = missingItems.map(it => `#${it.id} ${it.original}`).join('\n');
            const retryMessage = `Dưới đây là các câu còn thiếu hoặc cần dịch lại từ lượt trước. Hãy dịch chuẩn xác sang tiếng Việt theo đúng ngữ cảnh đã dịch.

YÊU CẦU BẮT BUỘC:
1. CHỈ trả về đúng định dạng chuẩn: #ID <Bản dịch tiếng Việt>
2. Mỗi câu một dòng tương ứng với đúng số #ID.
3. TUYỆT ĐỐI KHÔNG giải thích, không thêm lời chào, không dùng khối mã markdown (\`\`\`).

${missingLines}`;

            const retrySent = await sendMessageAndWaitConfirmation(retryMessage);
            if (!retrySent) {
                retryAttempt++;
                continue;
            }

            const retryResponse = await monitorAiResponse();
            const missingSet = new Set(missingItems.map(it => it.id));
            const retryParsed = parseAiResponse(retryResponse, missingSet);

            for (const [idStr, trans] of Object.entries(retryParsed)) {
                const id = Number(idStr);
                const it = itemMap.get(id);
                if (it) {
                    const check = isTranslationValid(it.original, trans);
                    if (check.valid) {
                        it.translated = trans;
                        it.status = 'translated';
                    }
                }
            }

            updateSessionProgress();
            retryAttempt++;
        }

        const stillMissing = batchItems.filter(it => !it.translated || it.status !== 'translated');
        if (stillMissing.length > 0) {
            throw new Error(`Đoạn ${batchIdx} còn thiếu ${stillMissing.length} câu sau ${CONFIG.MAX_RETRIES} lần thử lại.`);
        }

        saveSessionToStorage();
        return true;
    }

    async function startTranslationProcess() {
        if (!currentSession.items || currentSession.items.length === 0) {
            alert('Vui lòng chọn file phụ đề SRT trước.');
            return;
        }

        // 1. Kiểm tra cấu hình và cảnh báo nếu chọn Gửi toàn bộ
        const totalItems = currentSession.items.length;
        const mode = userSettings.mode;
        let batchSize = userSettings.batchSize;

        if (mode === 'all') {
            batchSize = totalItems;
            const totalChars = currentSession.items.reduce((sum, it) => sum + it.original.length, 0);

            if (totalItems > CONFIG.SAFE_FULL_MODE_ITEMS || totalChars > CONFIG.SAFE_FULL_MODE_CHARS) {
                const confirmMsg = `CẢNH BÁO: File có ${totalItems.toLocaleString('vi-VN')} dòng phụ đề (~${totalChars.toLocaleString('vi-VN')} ký tự).\n\n` +
                    `Gửi toàn bộ trong 1 lần vượt ngưỡng tối ưu của DeepSeek, dễ dẫn đến bị ngắt câu hoặc lỗi giới hạn độ dài.\n\n` +
                    `Bạn có muốn tiếp tục gửi toàn bộ không?\n` +
                    `• Nhấn [OK] để tiếp tục gửi toàn bộ.\n` +
                    `• Nhấn [Cancel] để quay lại và chọn 'Gửi theo số dòng' (khuyên dùng 50-100 dòng/lần).`;
                if (!confirm(confirmMsg)) {
                    updateUIStatus('Đã hủy gửi toàn bộ. Vui lòng chọn chế độ chia đoạn.');
                    return;
                }
            }
        }

        currentSession.isTranslating = true;
        currentSession.stopRequested = false;
        updateUIState(true);

        const totalBatches = Math.ceil(totalItems / batchSize);
        currentSession.totalBatches = totalBatches;

        try {
            updateUIStatus('Đang kiểm tra giao diện DeepSeek...');
            const input = findChatInput();
            if (!input) {
                throw new Error('Không tìm thấy khung nhập tin nhắn của DeepSeek. Vui lòng kiểm tra đã đăng nhập chưa.');
            }

            for (let b = currentSession.currentBatchIndex; b < totalBatches; b++) {
                if (currentSession.stopRequested) {
                    updateUIStatus('Đã dừng tiến trình dịch.');
                    break;
                }

                currentSession.currentBatchIndex = b;
                const startIdx = b * batchSize;
                const endIdx = Math.min(startIdx + batchSize, totalItems);
                const batchItems = currentSession.items.slice(startIdx, endIdx);

                await processBatchWithRetries(batchItems, b + 1, totalBatches);

                if (b + 1 < totalBatches && !currentSession.stopRequested) {
                    updateUIStatus(`Đang tạo cuộc trò chuyện mới cho đoạn ${b + 2}/${totalBatches}...`);
                    await createNewChat();
                    await sleep(2000);
                }
            }

            const missingTotal = currentSession.items.filter(it => !it.translated || it.status !== 'translated');
            if (missingTotal.length === 0 && !currentSession.stopRequested) {
                updateUIStatus('Đang tạo file phụ đề hoàn chỉnh...');
                await sleep(500);
                downloadTranslatedSrt();
                updateUIStatus('Hoàn thành! Đã tự động tải file SRT.');
                clearSessionStorage();
            } else if (!currentSession.stopRequested) {
                updateUIStatus(`Dịch chưa xong: Còn thiếu ${missingTotal.length} câu.`);
            }

        } catch (error) {
            console.error('[KageVietSub Error]', error);
            if (error.message === 'DEEPSEEK_LENGTH_LIMIT') {
                if (mode === 'all') {
                    alert('DeepSeek đã đạt giới hạn độ dài hội thoại trong chế độ Gửi toàn bộ!\n\nKhuyên dùng: Hãy chuyển sang "Gửi theo số dòng" (50 hoặc 100 dòng/lần) để dịch từng đoạn an toàn.');
                    updateUIStatus('Gặp lỗi giới hạn độ dài. Hãy chuyển sang "Gửi theo số dòng".');
                } else {
                    updateUIStatus('DeepSeek đạt giới hạn độ dài! Đang mở chat mới và thử lại...');
                    await createNewChat();
                    await sleep(2000);
                    setTimeout(startTranslationProcess, 1000);
                    return;
                }
            } else {
                updateUIStatus(`Lỗi: ${error.message || error}`);
                alert(`Lỗi trong quá trình dịch: ${error.message || error}`);
            }
        } finally {
            currentSession.isTranslating = false;
            updateUIState(false);
        }
    }

    // =========================================================================
    // 6. TẠO VÀ TỰ ĐỘNG TẢI FILE SRT HOÀN CHỈNH
    // =========================================================================

    function buildCompleteSrtContent() {
        const blocks = [];
        for (let i = 0; i < currentSession.items.length; i++) {
            const it = currentSession.items[i];
            const text = it.translated || it.original;
            blocks.push(`${i + 1}\n${it.timeline}\n${text}`);
        }
        return blocks.join('\n\n') + '\n';
    }

    function downloadTranslatedSrt() {
        const srtContent = buildCompleteSrtContent();
        let baseName = currentSession.fileName || 'phu_de';
        if (baseName.toLowerCase().endsWith('.srt')) {
            baseName = baseName.substring(0, baseName.length - 4);
        }
        baseName = baseName.replace(/_dich(_\d+)?$/i, '');
        const outputName = `${baseName}_dich.srt`;

        const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outputName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 2000);
    }

    // =========================================================================
    // 7. LƯU VÀ KHÔI PHỤC TIẾN TRÌNH (SESSION STORAGE)
    // =========================================================================

    function saveSessionToStorage() {
        try {
            const data = {
                fileName: currentSession.fileName,
                items: currentSession.items,
                currentBatchIndex: currentSession.currentBatchIndex,
                totalBatches: currentSession.totalBatches,
                timestamp: Date.now()
            };
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[KageVietSub] Không thể lưu tiến trình vào localStorage:', e);
        }
    }

    function loadSessionFromStorage() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.warn('[KageVietSub] Lỗi đọc tiến trình cũ:', e);
        }
        return null;
    }

    function clearSessionStorage() {
        try {
            localStorage.removeItem(CONFIG.STORAGE_KEY);
        } catch (e) { }
    }

    // =========================================================================
    // 8. GIAO DIỆN NGƯỜI DÙNG MOBILE (HTML + CSS) - CẬP NHẬT MỤC 16
    // =========================================================================

    let uiElements = {
        container: null,
        header: null,
        fileInput: null,
        selectFileBtn: null,
        fileNameLabel: null,
        totalCountLabel: null,
        modeSelect: null,
        batchSizeContainer: null,
        batchSelect: null,
        batchCustomInput: null,
        startBtn: null,
        progressLabel: null,
        progressBar: null,
        statusLabel: null,
        collapseBtn: null,
        contentBody: null
    };

    function injectUI() {
        if (document.getElementById('kagevietsub-mobile-widget')) return;

        loadUserConfig();

        const container = document.createElement('div');
        container.id = 'kagevietsub-mobile-widget';
        container.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            width: calc(100vw - 20px);
            max-width: 340px;
            background: #18191f;
            color: #e6e6e6;
            border: 1px solid #333544;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            box-sizing: border-box;
            user-select: none;
            overflow: hidden;
            transition: all 0.25s ease;
        `;

        container.innerHTML = `
            <div id="kg-header" style="
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #20222c;
                border-bottom: 1px solid #333544;
                cursor: pointer;
            ">
                <span style="font-weight: 700; color: #4e8cff; letter-spacing: 0.5px;">KAGEVIETSUB TRANSLATOR</span>
                <span id="kg-collapse-btn" style="
                    font-size: 18px;
                    color: #9ea3b5;
                    font-weight: bold;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">−</span>
            </div>
            <div id="kg-body" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;">
                <input type="file" id="kg-file-input" accept=".srt" style="display: none;" />
                <button id="kg-select-file-btn" style="
                    background: #282a36;
                    color: #cfd3dc;
                    border: 1px dashed #4e8cff;
                    border-radius: 8px;
                    padding: 10px 14px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    width: 100%;
                    min-height: 42px;
                    box-sizing: border-box;
                    text-align: center;
                    touch-action: manipulation;
                ">[ Chọn file SRT ]</button>

                <div id="kg-file-meta" style="
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    background: #20222c;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid #2b2e3b;
                ">
                    <div id="kg-filename-label" style="font-size: 12px; color: #9ea3b5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        Tên file: <span style="color: #ffffff; font-weight: 500;">(Chưa chọn)</span>
                    </div>
                    <div id="kg-total-count-label" style="font-size: 12px; color: #9ea3b5;">
                        Tổng phụ đề: <span style="color: #ffffff; font-weight: 500;">0 dòng</span>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 12px; color: #8c90a4; font-weight: 600;">Chế độ gửi:</label>
                    <select id="kg-mode-select" style="
                        background: #20222c;
                        color: #ffffff;
                        border: 1px solid #3a3d4d;
                        border-radius: 6px;
                        padding: 8px 10px;
                        font-size: 13px;
                        cursor: pointer;
                        outline: none;
                        min-height: 38px;
                    ">
                        <option value="lines">Gửi theo số dòng ▼</option>
                        <option value="all">Gửi toàn bộ SRT</option>
                    </select>
                </div>

                <div id="kg-batch-container" style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 12px; color: #8c90a4; font-weight: 600;">Số dòng mỗi lần:</label>
                    <div style="display: flex; gap: 6px;">
                        <select id="kg-batch-select" style="
                            flex: 1;
                            background: #20222c;
                            color: #ffffff;
                            border: 1px solid #3a3d4d;
                            border-radius: 6px;
                            padding: 8px 10px;
                            font-size: 13px;
                            cursor: pointer;
                            outline: none;
                            min-height: 38px;
                        ">
                            <option value="20">20 dòng</option>
                            <option value="50">50 dòng</option>
                            <option value="100">100 dòng</option>
                            <option value="200">200 dòng</option>
                            <option value="300">300 dòng</option>
                            <option value="custom">Tùy chỉnh số dòng...</option>
                        </select>
                        <input type="number" id="kg-batch-custom-input" min="5" max="1000" placeholder="Số dòng" style="
                            display: none;
                            width: 85px;
                            background: #20222c;
                            color: #ffffff;
                            border: 1px solid #4e8cff;
                            border-radius: 6px;
                            padding: 6px 8px;
                            font-size: 13px;
                            outline: none;
                            box-sizing: border-box;
                        " />
                    </div>
                </div>

                <button id="kg-start-btn" disabled style="
                    background: #4e8cff;
                    color: #ffffff;
                    border: none;
                    border-radius: 8px;
                    padding: 12px 14px;
                    font-size: 14px;
                    font-weight: 700;
                    cursor: pointer;
                    width: 100%;
                    min-height: 44px;
                    box-sizing: border-box;
                    text-align: center;
                    touch-action: manipulation;
                    opacity: 0.5;
                    transition: all 0.2s ease;
                ">[ BẮT ĐẦU DỊCH ]</button>

                <div style="border-top: 1px dashed #333544; margin: 2px 0;"></div>

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span id="kg-progress-label" style="font-weight: 600; color: #cfd3dc; font-size: 12px;">Tiến trình: 0%</span>
                    <span id="kg-count-label" style="color: #8c90a4; font-size: 11px;">0/0 câu</span>
                </div>

                <div style="
                    width: 100%;
                    height: 8px;
                    background: #2b2d3a;
                    border-radius: 4px;
                    overflow: hidden;
                ">
                    <div id="kg-progress-bar" style="
                        width: 0%;
                        height: 100%;
                        background: linear-gradient(90deg, #4e8cff, #00d2ff);
                        transition: width 0.3s ease;
                    "></div>
                </div>

                <div id="kg-status-label" style="
                    color: #9ea3b5;
                    font-size: 12px;
                    min-height: 16px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                ">Đang chờ bắt đầu...</div>

                <div id="kg-resume-banner" style="
                    display: none;
                    background: #232733;
                    border: 1px solid #4e8cff;
                    border-radius: 8px;
                    padding: 8px 10px;
                    flex-direction: column;
                    gap: 6px;
                ">
                    <span style="color: #4e8cff; font-weight: 600; font-size: 12px;">Tìm thấy phiên dịch dở dang!</span>
                    <div style="display: flex; gap: 6px;">
                        <button id="kg-resume-btn" style="
                            flex: 1;
                            background: #2e7d32;
                            color: white;
                            border: none;
                            border-radius: 6px;
                            padding: 6px;
                            font-size: 11px;
                            font-weight: 600;
                            cursor: pointer;
                            min-height: 36px;
                        ">Tiếp tục</button>
                        <button id="kg-discard-btn" style="
                            flex: 1;
                            background: #c62828;
                            color: white;
                            border: none;
                            border-radius: 6px;
                            padding: 6px;
                            font-size: 11px;
                            font-weight: 600;
                            cursor: pointer;
                            min-height: 36px;
                        ">Hủy bỏ</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        // Tham chiếu DOM
        uiElements.container = container;
        uiElements.header = container.querySelector('#kg-header');
        uiElements.fileInput = container.querySelector('#kg-file-input');
        uiElements.selectFileBtn = container.querySelector('#kg-select-file-btn');
        uiElements.fileNameLabel = container.querySelector('#kg-filename-label');
        uiElements.totalCountLabel = container.querySelector('#kg-total-count-label');
        uiElements.modeSelect = container.querySelector('#kg-mode-select');
        uiElements.batchSizeContainer = container.querySelector('#kg-batch-container');
        uiElements.batchSelect = container.querySelector('#kg-batch-select');
        uiElements.batchCustomInput = container.querySelector('#kg-batch-custom-input');
        uiElements.startBtn = container.querySelector('#kg-start-btn');
        uiElements.progressLabel = container.querySelector('#kg-progress-label');
        uiElements.progressBar = container.querySelector('#kg-progress-bar');
        uiElements.statusLabel = container.querySelector('#kg-status-label');
        uiElements.collapseBtn = container.querySelector('#kg-collapse-btn');
        uiElements.contentBody = container.querySelector('#kg-body');
        uiElements.countLabel = container.querySelector('#kg-count-label');

        // Khôi phục cấu hình trên UI
        syncConfigToUI();

        // Sự kiện đổi chế độ gửi
        uiElements.modeSelect.addEventListener('change', () => {
            const val = uiElements.modeSelect.value;
            userSettings.mode = val;
            if (val === 'all') {
                uiElements.batchSizeContainer.style.display = 'none';
            } else {
                uiElements.batchSizeContainer.style.display = 'flex';
            }
            saveUserConfig(userSettings.mode, userSettings.batchSize);
        });

        // Sự kiện đổi số dòng mỗi lần
        uiElements.batchSelect.addEventListener('change', () => {
            const val = uiElements.batchSelect.value;
            if (val === 'custom') {
                uiElements.batchCustomInput.style.display = 'block';
                uiElements.batchCustomInput.value = userSettings.batchSize || 100;
                uiElements.batchCustomInput.focus();
            } else {
                uiElements.batchCustomInput.style.display = 'none';
                userSettings.batchSize = Number(val);
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        });

        uiElements.batchCustomInput.addEventListener('input', () => {
            const val = parseInt(uiElements.batchCustomInput.value, 10);
            if (val && val > 0) {
                userSettings.batchSize = val;
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        });

        // Sự kiện chọn file
        uiElements.selectFileBtn.addEventListener('click', () => {
            if (currentSession.isTranslating) {
                alert('Tiến trình dịch đang chạy. Hãy nhấn [ DỪNG DỊCH ] trước khi chọn file khác.');
                return;
            }
            uiElements.fileInput.click();
        });

        uiElements.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            updateUIStatus('Đang đọc file phụ đề...');
            const reader = new FileReader();

            reader.onload = (evt) => {
                try {
                    const text = evt.target.result;
                    const items = parseSrtContent(text);
                    if (items.length === 0) {
                        alert('Không nhận diện được cấu trúc phụ đề SRT hợp lệ trong file này.');
                        updateUIStatus('Lỗi: File SRT không hợp lệ.');
                        return;
                    }

                    currentSession.fileName = file.name;
                    currentSession.items = items;
                    currentSession.currentBatchIndex = 0;

                    // Cập nhật thông tin file và số dòng lên giao diện
                    uiElements.fileNameLabel.innerHTML = `Tên file: <span style="color: #ffffff; font-weight: 600;">${file.name}</span>`;
                    uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span style="color: #ffffff; font-weight: 600;">${items.length.toLocaleString('vi-VN')} dòng</span>`;

                    // Kích hoạt nút BẮT ĐẦU DỊCH (KHÔNG tự động dịch ngay!)
                    uiElements.startBtn.disabled = false;
                    uiElements.startBtn.style.opacity = '1';
                    uiElements.startBtn.innerText = '[ BẮT ĐẦU DỊCH ]';
                    uiElements.startBtn.style.background = '#4e8cff';

                    updateSessionProgress();
                    updateUIStatus('Đã đọc file xong. Hãy xác nhận chế độ và nhấn [ BẮT ĐẦU DỊCH ].');
                } catch (err) {
                    alert('Lỗi khi đọc file SRT: ' + err);
                    updateUIStatus('Lỗi đọc file.');
                }
            };

            reader.readAsText(file, 'utf-8');
        });

        // Sự kiện nút BẮT ĐẦU DỊCH / DỪNG DỊCH
        uiElements.startBtn.addEventListener('click', () => {
            if (currentSession.isTranslating) {
                if (confirm('Bạn có chắc muốn dừng tiến trình dịch hiện tại không? Dữ liệu đã dịch vẫn được giữ nguyên.')) {
                    currentSession.stopRequested = true;
                    updateUIStatus('Đang gửi lệnh dừng...');
                }
                return;
            }

            if (!currentSession.items || currentSession.items.length === 0) {
                alert('Vui lòng chọn file SRT trước.');
                return;
            }

            // Bắt đầu dịch
            startTranslationProcess();
        });

        // Thu gọn / mở rộng giao diện
        let isCollapsed = false;
        uiElements.header.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            if (isCollapsed) {
                uiElements.contentBody.style.display = 'none';
                uiElements.collapseBtn.innerText = '+';
                container.style.width = 'auto';
            } else {
                uiElements.contentBody.style.display = 'flex';
                uiElements.collapseBtn.innerText = '−';
                container.style.width = 'calc(100vw - 20px)';
            }
        });

        checkSavedSession();
    }

    function syncConfigToUI() {
        if (!uiElements.modeSelect) return;
        uiElements.modeSelect.value = userSettings.mode;
        if (userSettings.mode === 'all') {
            uiElements.batchSizeContainer.style.display = 'none';
        } else {
            uiElements.batchSizeContainer.style.display = 'flex';
        }

        const bSize = userSettings.batchSize;
        const validPresets = ['20', '50', '100', '200', '300'];
        if (validPresets.includes(String(bSize))) {
            uiElements.batchSelect.value = String(bSize);
            uiElements.batchCustomInput.style.display = 'none';
        } else {
            uiElements.batchSelect.value = 'custom';
            uiElements.batchCustomInput.style.display = 'block';
            uiElements.batchCustomInput.value = bSize;
        }
    }

    function updateUIStatus(text) {
        if (uiElements.statusLabel) {
            uiElements.statusLabel.innerText = text;
            uiElements.statusLabel.title = text;
        }
    }

    function updateSessionProgress() {
        if (!currentSession.items || currentSession.items.length === 0) return;
        const total = currentSession.items.length;
        const translatedCount = currentSession.items.filter(it => it.translated && it.status === 'translated').length;
        const percent = Math.min(100, Math.round((translatedCount / total) * 100));

        if (uiElements.progressLabel) {
            uiElements.progressLabel.innerText = `Tiến trình: ${percent}%`;
        }
        if (uiElements.countLabel) {
            uiElements.countLabel.innerText = `${translatedCount}/${total} câu`;
        }
        if (uiElements.progressBar) {
            uiElements.progressBar.style.width = `${percent}%`;
        }
    }

    function updateUIState(isTranslating) {
        if (!uiElements.startBtn) return;
        if (isTranslating) {
            uiElements.startBtn.innerText = '[ DỪNG DỊCH ]';
            uiElements.startBtn.style.background = '#d32f2f';
            uiElements.selectFileBtn.style.pointerEvents = 'none';
            uiElements.selectFileBtn.style.opacity = '0.5';
            uiElements.modeSelect.disabled = true;
            uiElements.batchSelect.disabled = true;
            if (uiElements.batchCustomInput) uiElements.batchCustomInput.disabled = true;
        } else {
            uiElements.startBtn.innerText = '[ BẮT ĐẦU DỊCH ]';
            uiElements.startBtn.style.background = '#4e8cff';
            uiElements.selectFileBtn.style.pointerEvents = 'auto';
            uiElements.selectFileBtn.style.opacity = '1';
            uiElements.modeSelect.disabled = false;
            uiElements.batchSelect.disabled = false;
            if (uiElements.batchCustomInput) uiElements.batchCustomInput.disabled = false;
        }
    }

    function checkSavedSession() {
        const saved = loadSessionFromStorage();
        if (saved && saved.items && saved.items.length > 0) {
            const translatedCount = saved.items.filter(it => it.translated && it.status === 'translated').length;
            if (translatedCount > 0 && translatedCount < saved.items.length) {
                const banner = document.getElementById('kg-resume-banner');
                if (banner) {
                    banner.style.display = 'flex';
                    const resumeBtn = document.getElementById('kg-resume-btn');
                    const discardBtn = document.getElementById('kg-discard-btn');

                    resumeBtn.onclick = () => {
                        currentSession = {
                            fileName: saved.fileName,
                            items: saved.items,
                            isTranslating: false,
                            stopRequested: false,
                            currentBatchIndex: saved.currentBatchIndex || 0,
                            totalBatches: saved.totalBatches || Math.ceil(saved.items.length / (userSettings.batchSize || 100))
                        };
                        banner.style.display = 'none';

                        // Hiển thị tên file và tổng phụ đề
                        if (uiElements.fileNameLabel) {
                            uiElements.fileNameLabel.innerHTML = `Tên file: <span style="color: #ffffff; font-weight: 600;">${saved.fileName}</span>`;
                        }
                        if (uiElements.totalCountLabel) {
                            uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span style="color: #ffffff; font-weight: 600;">${saved.items.length.toLocaleString('vi-VN')} dòng</span>`;
                        }
                        if (uiElements.startBtn) {
                            uiElements.startBtn.disabled = false;
                            uiElements.startBtn.style.opacity = '1';
                        }

                        updateSessionProgress();
                        updateUIStatus(`Đã khôi phục ${translatedCount}/${saved.items.length} câu. Nhấn [ BẮT ĐẦU DỊCH ] để tiếp tục.`);
                    };

                    discardBtn.onclick = () => {
                        clearSessionStorage();
                        banner.style.display = 'none';
                        updateUIStatus('Đã hủy phiên dịch cũ.');
                    };
                }
            }
        }
    }

    // =========================================================================
    // 9. KHỞI CHẠY TỰ ĐỘNG
    // =========================================================================
    window.addEventListener('load', () => {
        setTimeout(injectUI, 1200);
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectUI, 1000);
    }

})();
