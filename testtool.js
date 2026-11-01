// ==UserScript==
// @name         KAGEVIETSUB Mobile Translator
// @namespace    https://kagevietsub.com/
// @version      1.2.0
// @description  Tự động dịch file phụ đề SRT Trung - Việt bằng DeepSeek trên PC và trình duyệt điện thoại (Tự động nhận diện thiết bị).
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
    // 1. CẤU HÌNH & HẰNG SỐ CHUẨN GỐC (TỪ CONFIG.PY)
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
        // PROMPT CHUẨN GỐC TỪ DỰ ÁN KAGEVIETSUB TOOL (CONFIG.PY)
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

    // Trạng thái cấu hình người dùng (Nhóm A: Được lưu lâu dài)
    let userSettings = {
        mode: 'lines',           // 'lines' (theo số dòng) | 'all' (toàn bộ SRT)
        batchSize: 100           // 20, 50, 100, 200, 300, hoặc tùy chỉnh
    };

    // Trạng thái phiên làm việc hiện tại (Nhóm B: Chỉ tồn tại trong RAM/phiên, KHÔNG lưu lâu dài)
    let currentSession = {
        fileName: '',
        items: [],               // [{ id, timeline, original, translated, status }]
        isTranslating: false,
        stopRequested: false,
        currentBatchIndex: 0,
        totalBatches: 0,
        lastCompletedItem: null, // Lưu câu đã dịch gần nhất để làm ngữ cảnh khi phục hồi length limit
        detectedEnvironment: null
    };

    // =========================================================================
    // 2. NHẬN DIỆN MÔI TRƯỜNG THIẾT BỊ (MỤC 18 - DEVICE COMPATIBILITY MANAGER)
    // =========================================================================
    const DeviceCompatibilityManager = {
        MODE_DESKTOP: 'DESKTOP',
        MODE_MOBILE: 'MOBILE',
        currentMode: null,

        detect() {
            const ua = (navigator.userAgent || '').toLowerCase();
            const platform = (navigator.platform || '').toLowerCase();

            // 1. Kiểm tra khả năng cảm ứng (Touch capability)
            const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);

            // 2. Kiểm tra kiểu con trỏ (Coarse = ngón tay trên màn cảm ứng, Fine = chuột máy tính)
            let isCoarse = false;
            try {
                isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            } catch (e) {}

            // 3. Kiểm tra kiểu thiết bị và nền tảng
            const isMobileUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
            const isIpadOs = platform.includes('mac') && hasTouch && navigator.maxTouchPoints > 1;
            const isSmallScreen = window.innerWidth <= 768 || window.screen.width <= 768;

            // 4. Nguyên tắc: Điện thoại bật "Desktop Mode" vẫn có touch và màn hình nhỏ/coarse pointer
            if (hasTouch && (isMobileUa || isIpadOs || isCoarse || isSmallScreen)) {
                this.currentMode = this.MODE_MOBILE;
            } else {
                this.currentMode = this.MODE_DESKTOP;
            }

            currentSession.detectedEnvironment = this.currentMode;
            console.log(`%c[DeviceCompatibilityManager] Môi trường xác định: ${this.currentMode} (touch=${hasTouch}, coarsePointer=${isCoarse}, uaMobile=${isMobileUa}, viewport=${window.innerWidth}x${window.innerHeight})`, 'color: #00d2ff; font-weight: bold;');
            return this.currentMode;
        },

        isDesktop() {
            if (!this.currentMode) this.detect();
            return this.currentMode === this.MODE_DESKTOP;
        },

        isMobile() {
            if (!this.currentMode) this.detect();
            return this.currentMode === this.MODE_MOBILE;
        }
    };

    // =========================================================================
    // 3. BỘ ĐỆM LƯU TRỮ ĐA MÔI TRƯỜNG (STORAGE ADAPTER - MỤC 16.7 & 22)
    // Phân tách nghiêm ngặt: Nhóm A (Lưu) vs Nhóm B (Không lưu)
    // =========================================================================
    const StorageAdapter = {
        get(key, defaultValue) {
            // 1. Thử đọc từ GM_getValue (Tampermonkey, Violentmonkey)
            try {
                if (typeof GM_getValue === 'function') {
                    const gmVal = GM_getValue(key, undefined);
                    if (gmVal !== undefined && gmVal !== null && gmVal !== '') {
                        return gmVal;
                    }
                }
            } catch (err) {}

            // 2. Thử đọc từ window.localStorage (Userscripts iOS, Web tiêu chuẩn)
            try {
                if (typeof window !== 'undefined' && window.localStorage) {
                    const localVal = window.localStorage.getItem(key);
                    if (localVal !== null && localVal !== undefined && localVal !== '') {
                        try {
                            return JSON.parse(localVal);
                        } catch (parseErr) {
                            return localVal;
                        }
                    }
                }
            } catch (err) {}

            return defaultValue;
        },

        set(key, value) {
            // 1. Ghi vào GM_setValue nếu khả dụng
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                }
            } catch (err) {}

            // 2. Ghi đồng thời vào localStorage để bảo toàn dữ liệu
            try {
                if (typeof window !== 'undefined' && window.localStorage) {
                    const serialized = (typeof value === 'object') ? JSON.stringify(value) : String(value);
                    window.localStorage.setItem(key, serialized);
                }
            } catch (err) {}
        },

        remove(key) {
            try {
                if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
            } catch (e) {}
            try {
                if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(key);
            } catch (e) {}
        }
    };

    // Chỉ đọc/ghi các thông số cấu hình Nhóm A
    function loadUserConfig() {
        let rawMode = StorageAdapter.get(CONFIG.CONFIG_KEY_MODE, 'lines');
        let rawBatch = StorageAdapter.get(CONFIG.CONFIG_KEY_BATCH, CONFIG.DEFAULT_BATCH_SIZE);

        userSettings.mode = (rawMode === 'all') ? 'all' : 'lines';

        let parsedBatch = parseInt(rawBatch, 10);
        if (isNaN(parsedBatch) || parsedBatch < 5 || parsedBatch > 2000) {
            parsedBatch = CONFIG.DEFAULT_BATCH_SIZE;
        }
        userSettings.batchSize = parsedBatch;
    }

    function saveUserConfig(mode, batchSize) {
        userSettings.mode = (mode === 'all') ? 'all' : 'lines';
        const num = parseInt(batchSize, 10);
        if (!isNaN(num) && num >= 5) {
            userSettings.batchSize = num;
        }

        StorageAdapter.set(CONFIG.CONFIG_KEY_MODE, userSettings.mode);
        StorageAdapter.set(CONFIG.CONFIG_KEY_BATCH, userSettings.batchSize);
    }

    // =========================================================================
    // 4. CÔNG CỤ XỬ LÝ SRT & KIỂM TRA CHẤT LƯỢNG (PORT TỪ PYTHON TOOL PC)
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

        // 1. Phân tích định dạng chuẩn #ID Nội dung
        const lines = cleaned.split('\n');
        const lineRegex = /^#\s*(\d+)[\s:：.\-]+(.*)$/;

        for (const line of lines) {
            const trimmed = line.trim();
            const match = trimmed.match(lineRegex);
            if (match) {
                const id = parseInt(match[1], 10);
                let content = match[2].trim();
                if (content.includes('-->') || content.includes('->')) {
                    content = content.replace(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*(?:-->|->)\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g, '').trim();
                }
                if (expectedIdSet.has(id) && content) {
                    resultMap[id] = content;
                }
            }
        }

        // 2. Fallback: Nếu AI tự sinh lại nguyên khối SRT kèm timestamp
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
    // 5. TƯƠNG TÁC DOM DEEPSEEK (PHÂN BIỆT RÕ PC VÀ MOBILE - MỤC 18)
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

    // Đưa nội dung nhiều dòng vào ô nhập
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
            element.innerText = text;
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
    }

    // Cơ chế PC: Gửi bằng phím Enter đúng như tool PC (browser_controller.py dòng 1920)
    function sendViaKeyboardEnter(composer) {
        composer.focus();
        const evtDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const evtPress = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const evtUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        composer.dispatchEvent(evtDown);
        composer.dispatchEvent(evtPress);
        composer.dispatchEvent(evtUp);
    }

    // Cơ chế Mobile: Tìm nút gửi thực tế của DeepSeek
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
    // 6. TIẾN TRÌNH GỬI TIN NHẮN (ÁP DỤNG CƠ CHẾ ĐÚNG CHO TỪNG THIẾT BỊ)
    // =========================================================================

    async function sendMessageAndWaitConfirmation(textToSend, maxWaitMs = 8000) {
        const input = findChatInput();
        if (!input) {
            throw new Error('Không tìm thấy khung nhập tin nhắn của DeepSeek.');
        }

        setInputValue(input, textToSend);
        await sleep(500);

        const baselineCount = getAssistantMessageCount();
        const isDesktop = DeviceCompatibilityManager.isDesktop();

        if (isDesktop) {
            // PC: Thực hiện gửi bằng phím Enter y hệt tool PC gốc
            console.log('[KageVietSub Send] Thực thi cơ chế DESKTOP: Gửi bằng phím Enter...');
            sendViaKeyboardEnter(input);

            // Kiểm tra và retry Enter sau 1.5s nếu chưa gửi được
            await sleep(1500);
            const curVal = (input.tagName.toLowerCase() === 'textarea' ? input.value : input.innerText) || '';
            if (curVal.length > 0 && !isAiGenerating() && !isAiThinking()) {
                console.log('[KageVietSub Send] Thử lại Enter lần 2 trên PC...');
                sendViaKeyboardEnter(input);
            }
        } else {
            // MOBILE: Tuyệt đối không bấm Enter; tìm nút gửi và click thực tế
            console.log('[KageVietSub Send] Thực thi cơ chế MOBILE: Tìm và click nút gửi thực tế...');
            let sendBtn = null;
            const startFind = Date.now();
            while (Date.now() - startFind < 4000) {
                sendBtn = findSendButton();
                if (sendBtn) break;
                await sleep(200);
            }

            if (!sendBtn) {
                throw new Error('Nút gửi (Send button) chưa sẵn sàng hoặc không tìm thấy trên điện thoại.');
            }

            clickButton(sendBtn);
        }

        // Chờ xác nhận đã gửi thành công
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

    // =========================================================================
    // 7. PHỤC HỒI KHI DEEPSEEK ĐẠT GIỚI HẠN ĐỘ DÀI (LENGTH LIMIT RECOVERY)
    // Port nguyên vẹn từ recover_deepseek_length_limit trong translator.py
    // =========================================================================
    async function recoverDeepSeekLengthLimit(batchItems, activePrompt, batchIdx, totalBatches) {
        console.warn('[KageVietSub Recovery] Kích hoạt quy trình phục hồi Length Limit chuẩn PC...');
        updateUIStatus('Phát hiện DeepSeek Length Limit! Đang tạo chat mới và nạp ngữ cảnh...');

        const itemMap = new Map(batchItems.map(it => [it.id, it]));
        const expectedIds = batchItems.map(it => it.id);

        for (let attempt = 1; attempt <= 3; attempt++) {
            if (currentSession.stopRequested) return false;

            const missingIds = expectedIds.filter(id => {
                const it = itemMap.get(id);
                return !it || !it.translated || it.status !== 'translated';
            });

            if (missingIds.length === 0) {
                updateUIStatus('Khôi phục thành công! Đã dịch đủ các câu.');
                return true;
            }

            updateUIStatus(`Khôi phục lần ${attempt}/3: Mở chat mới cho ${missingIds.length} câu còn thiếu...`);
            const newChatOk = await createNewChat();
            if (!newChatOk) {
                await sleep(1500);
                continue;
            }
            await sleep(1500);

            // Xây dựng thông điệp phục hồi kèm câu ngữ cảnh tham chiếu liền trước (nếu có)
            const contextItem = currentSession.lastCompletedItem;
            let contextBlock = '';
            const firstMissingId = missingIds[0];

            if (contextItem) {
                contextBlock = `--- [DÒNG NGỮ CẢNH THAM CHIẾU - BẮT BUỘC ĐỌC KỸ] ---
Dưới đây là câu liền trước đã dịch thành công, cung cấp DUY NHẤT để bạn nắm bắt mạch nội dung:
#${contextItem.id} [Gốc]: ${normalizeText(contextItem.original)}
#${contextItem.id} [Đã dịch]: ${normalizeText(contextItem.translated || '')}

QUY TẮC BẮT BUỘC VỀ DÒNG NGỮ CẢNH:
- Đây là dòng ngữ cảnh để AI hiểu mạch nội dung.
- AI TUYỆT ĐỐI KHÔNG ĐƯỢC dịch lại câu #${contextItem.id}.
- AI TUYỆT ĐỐI KHÔNG ĐƯỢC đưa câu #${contextItem.id} vào kết quả trả về.
- Bắt đầu dịch chính xác từ câu #${firstMissingId} (đoạn bị thiếu đầu tiên).
- Giữ nguyên số thứ tự #${firstMissingId} trở đi và định dạng chuẩn.
---------------------------------------------------\n\n`;
            }

            const missingLines = missingIds.map(id => `#${id} ${itemMap.get(id).original}`).join('\n');
            const recoveryMessage = `${activePrompt}\n\n${contextBlock}DANH SÁCH CÁC CÂU CẦN DỊCH (Bắt đầu chính xác từ #${firstMissingId}):\n${missingLines}`;

            const sent = await sendMessageAndWaitConfirmation(recoveryMessage);
            if (!sent) {
                await sleep(1000);
                continue;
            }

            const resp = await monitorAiResponse();
            const missingSet = new Set(missingIds);
            const parsed = parseAiResponse(resp, missingSet);

            for (const [idStr, trans] of Object.entries(parsed)) {
                const id = Number(idStr);
                // Bỏ qua dòng ngữ cảnh nếu AI lỡ trả lại
                if (contextItem && id === contextItem.id) continue;

                const it = itemMap.get(id);
                if (it && isTranslationValid(it.original, trans).valid) {
                    it.translated = trans;
                    it.status = 'translated';
                    currentSession.lastCompletedItem = it;
                }
            }

            updateSessionProgress();
        }

        const stillMissing = expectedIds.filter(id => !itemMap.get(id).translated);
        return stillMissing.length === 0;
    }

    // =========================================================================
    // 8. TIẾN TRÌNH DỊCH TỪNG ĐOẠN & RETRY THIẾU DÒNG (SMART RETRY)
    // =========================================================================
    async function processBatchWithRetries(batchItems, activePrompt, batchIdx, totalBatches) {
        const expectedIds = batchItems.map(it => it.id);
        const expectedSet = new Set(expectedIds);
        const itemMap = new Map(batchItems.map(it => [it.id, it]));

        updateUIStatus(`Đang dịch đoạn ${batchIdx}/${totalBatches}...`);

        const dataLines = batchItems.map(it => `#${it.id} ${it.original}`).join('\n');
        const initialPrompt = `${activePrompt}\n\n${dataLines}`;

        const sent = await sendMessageAndWaitConfirmation(initialPrompt);
        if (!sent) {
            throw new Error(`Không thể gửi batch ${batchIdx} vào DeepSeek.`);
        }

        updateUIStatus(`Đang chờ DeepSeek trả lời đoạn ${batchIdx}/${totalBatches}...`);

        let responseText = '';
        try {
            responseText = await monitorAiResponse((text) => {
                const partial = parseAiResponse(text, expectedSet);
                for (const [id, trans] of Object.entries(partial)) {
                    const it = itemMap.get(Number(id));
                    if (it && isTranslationValid(it.original, trans).valid) {
                        it.translated = trans;
                        it.status = 'translated';
                        currentSession.lastCompletedItem = it;
                    }
                }
                updateSessionProgress();
            });
        } catch (err) {
            if (err.message === 'DEEPSEEK_LENGTH_LIMIT') {
                const recovered = await recoverDeepSeekLengthLimit(batchItems, activePrompt, batchIdx, totalBatches);
                if (!recovered) {
                    throw new Error(`Đoạn ${batchIdx} bị ngắt bởi Length Limit và không thể phục hồi.`);
                }
                saveSessionToStorage();
                return true;
            }
            throw err;
        }

        let parsedResults = parseAiResponse(responseText, expectedSet);
        for (const [idStr, trans] of Object.entries(parsedResults)) {
            const id = Number(idStr);
            const it = itemMap.get(id);
            if (it) {
                const check = isTranslationValid(it.original, trans);
                if (check.valid) {
                    it.translated = trans;
                    it.status = 'translated';
                    currentSession.lastCompletedItem = it;
                }
            }
        }

        // Vòng lặp Smart Retry nếu thiếu câu (tối đa CONFIG.MAX_RETRIES)
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

            let retryResponse = '';
            try {
                retryResponse = await monitorAiResponse();
            } catch (err) {
                if (err.message === 'DEEPSEEK_LENGTH_LIMIT') {
                    await recoverDeepSeekLengthLimit(batchItems, activePrompt, batchIdx, totalBatches);
                    break;
                }
                throw err;
            }

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
                        currentSession.lastCompletedItem = it;
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

    // =========================================================================
    // 9. TIẾN TRÌNH DỊCH TOÀN BỘ FILE (START TRANSLATION PIPELINE)
    // =========================================================================
    async function startTranslationProcess() {
        if (!currentSession.items || currentSession.items.length === 0) {
            alert('Vui lòng chọn file phụ đề SRT trước.');
            return;
        }

        // 1. Tự động xác định môi trường trình duyệt trước khi chạy (Mục 18)
        DeviceCompatibilityManager.detect();

        // 2. Xác định Prompt AI sử dụng (Mục 20)
        // Nếu người dùng nhập prompt tùy chỉnh, thay thế hoàn toàn prompt gốc. Nếu để trống, dùng prompt gốc.
        const customPromptText = (uiElements.customPromptInput ? uiElements.customPromptInput.value : '').trim();
        const activePrompt = customPromptText || CONFIG.DEFAULT_PROMPT;
        console.log(`[KageVietSub Prompt] Đang sử dụng: ${customPromptText ? 'PROMPT TÙY CHỈNH (In-memory)' : 'PROMPT GỐC CỦA TOOL PC'}`);

        // 3. Kiểm tra cấu hình và cảnh báo nếu chọn Gửi toàn bộ
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

                await processBatchWithRetries(batchItems, activePrompt, b + 1, totalBatches);

                // Sau mỗi batch hoàn thành, nếu còn batch tiếp theo -> tạo New Chat để giải phóng context
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
            updateUIStatus(`Lỗi: ${error.message || error}`);
            alert(`Lỗi trong quá trình dịch: ${error.message || error}`);
        } finally {
            currentSession.isTranslating = false;
            updateUIState(false);
        }
    }

    // =========================================================================
    // 10. XUẤT VÀ TẢI FILE SRT HOÀN CHỈNH
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

    // Nút tải prompt AI mẫu về thiết bị dưới dạng file .txt (Mục 21)
    function downloadSamplePrompt() {
        const blob = new Blob([CONFIG.DEFAULT_PROMPT], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'KAGEVIETSUB_DeepSeek_Prompt_Mau.txt';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 2000);
    }

    // =========================================================================
    // 11. LƯU VÀ KHÔI PHỤC TIẾN TRÌNH PHIÊN
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
            StorageAdapter.set(CONFIG.STORAGE_KEY, data);
        } catch (e) {
            console.warn('[KageVietSub] Không thể lưu tiến trình phiên:', e);
        }
    }

    function loadSessionFromStorage() {
        try {
            const saved = StorageAdapter.get(CONFIG.STORAGE_KEY, null);
            if (saved && typeof saved === 'object') {
                return saved;
            }
        } catch (e) {
            console.warn('[KageVietSub] Lỗi đọc tiến trình cũ:', e);
        }
        return null;
    }

    function clearSessionStorage() {
        StorageAdapter.remove(CONFIG.STORAGE_KEY);
    }

    // =========================================================================
    // 12. GIAO DIỆN NGƯỜI DÙNG (RESPONSIVE PC & MOBILE - MỤC 18, 20, 21)
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
        promptToggleBtn: null,
        promptBody: null,
        customPromptInput: null,
        downloadSamplePromptBtn: null,
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
            max-width: 350px;
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
            <div id="kg-body" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 9px; max-height: calc(100vh - 80px); overflow-y: auto;">
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

                <!-- KHU VỰC PROMPT AI TÙY CHỌN (MỤC 20 & 21) -->
                <div style="border: 1px solid #2b2e3b; border-radius: 6px; overflow: hidden; background: #1c1d25;">
                    <div id="kg-prompt-header" style="
                        padding: 7px 10px;
                        background: #22242f;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 600;
                        color: #cfd3dc;
                    ">
                        <span>PROMPT AI (Tùy chọn)</span>
                        <span id="kg-prompt-toggle-btn" style="color: #4e8cff; font-weight: bold;">+</span>
                    </div>
                    <div id="kg-prompt-body" style="display: none; padding: 10px; flex-direction: column; gap: 8px;">
                        <textarea id="kg-custom-prompt-input" placeholder="Để trống để dùng Prompt gốc của tool PC. Nhập prompt tại đây để thay thế hoàn toàn trong phiên hiện tại..." style="
                            width: 100%;
                            min-height: 75px;
                            max-height: 150px;
                            background: #18191f;
                            color: #e6e6e6;
                            border: 1px solid #3a3d4d;
                            border-radius: 6px;
                            padding: 6px 8px;
                            font-size: 11px;
                            font-family: inherit;
                            resize: vertical;
                            box-sizing: border-box;
                            outline: none;
                        "></textarea>
                        <button id="kg-download-sample-prompt-btn" type="button" style="
                            background: #252836;
                            color: #4e8cff;
                            border: 1px solid #4e8cff;
                            border-radius: 6px;
                            padding: 7px 10px;
                            font-size: 11px;
                            font-weight: 600;
                            cursor: pointer;
                            min-height: 32px;
                            text-align: center;
                        ">[ TẢI PROMPT MẪU (.TXT) ]</button>
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
        uiElements.promptToggleBtn = container.querySelector('#kg-prompt-toggle-btn');
        uiElements.promptBody = container.querySelector('#kg-prompt-body');
        uiElements.customPromptInput = container.querySelector('#kg-custom-prompt-input');
        uiElements.downloadSamplePromptBtn = container.querySelector('#kg-download-sample-prompt-btn');
        uiElements.startBtn = container.querySelector('#kg-start-btn');
        uiElements.progressLabel = container.querySelector('#kg-progress-label');
        uiElements.progressBar = container.querySelector('#kg-progress-bar');
        uiElements.statusLabel = container.querySelector('#kg-status-label');
        uiElements.collapseBtn = container.querySelector('#kg-collapse-btn');
        uiElements.contentBody = container.querySelector('#kg-body');
        uiElements.countLabel = container.querySelector('#kg-count-label');

        // Khôi phục cấu hình Nhóm A trên UI
        syncConfigToUI();

        // Thu gọn / mở rộng mục Prompt AI
        let isPromptExpanded = false;
        container.querySelector('#kg-prompt-header').addEventListener('click', () => {
            isPromptExpanded = !isPromptExpanded;
            uiElements.promptBody.style.display = isPromptExpanded ? 'flex' : 'none';
            uiElements.promptToggleBtn.innerText = isPromptExpanded ? '−' : '+';
        });

        // Nút tải prompt mẫu
        uiElements.downloadSamplePromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadSamplePrompt();
        });

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
                const curVal = parseInt(uiElements.batchCustomInput.value, 10) || userSettings.batchSize || CONFIG.DEFAULT_BATCH_SIZE;
                uiElements.batchCustomInput.value = curVal;
                userSettings.batchSize = curVal;
                saveUserConfig(userSettings.mode, userSettings.batchSize);
                uiElements.batchCustomInput.focus();
            } else {
                uiElements.batchCustomInput.style.display = 'none';
                userSettings.batchSize = Number(val);
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        });

        const handleCustomInput = () => {
            const val = parseInt(uiElements.batchCustomInput.value, 10);
            if (!isNaN(val) && val >= 5) {
                userSettings.batchSize = val;
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        };

        uiElements.batchCustomInput.addEventListener('input', handleCustomInput);
        uiElements.batchCustomInput.addEventListener('change', handleCustomInput);
        uiElements.batchCustomInput.addEventListener('blur', handleCustomInput);

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
                            totalBatches: saved.totalBatches || Math.ceil(saved.items.length / (userSettings.batchSize || 100)),
                            lastCompletedItem: null
                        };
                        banner.style.display = 'none';

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
    // 13. KHỞI CHẠY TỰ ĐỘNG
    // =========================================================================
    window.addEventListener('load', () => {
        setTimeout(injectUI, 1200);
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectUI, 1000);
    }

})();
