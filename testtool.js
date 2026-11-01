// ==UserScript==
// @name         KAGEVIETSUB Mobile Desktop Translator
// @namespace    https://kagevietsub.com/
// @version      1.3.0
// @description  Bản tích hợp hoàn chỉnh: Tự động chuyển DeepSeek sang Desktop Mode trên điện thoại và cung cấp toàn bộ công cụ dịch SRT chuyên nghiệp của KAGEVIETSUB.
// @author       KageVietSub Team
// @match        https://chat.deepseek.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

/**
 * ============================================================================
 * KAGEVIETSUB MOBILE DESKTOP TRANSLATOR (PHIÊN BẢN TÍCH HỢP HOÀN CHỈNH)
 * ============================================================================
 *
 * TÍCH HỢP:
 * 1. Cơ chế tự động kích hoạt Desktop Mode (1280px) trên điện thoại từ kagevietsub_desktop_test.user.js.
 * 2. Toàn bộ tính năng dịch phụ đề SRT chuẩn từ kagevietsub_mobile.user.js:
 *    - Đọc & phân tích SRT nhiều dòng, bảo toàn 100% timeline.
 *    - 2 Chế độ gửi: Gửi theo số dòng (batching) & Gửi toàn bộ SRT (kèm cảnh báo an toàn).
 *    - Quản lý Prompt AI tùy chỉnh (in-memory) & Tải prompt mẫu (.txt).
 *    - Tương tác DOM tự động thích ứng: PC dùng Enter keyboard event; Mobile click nút gửi thực tế.
 *    - Chống thiếu dòng (Smart Retry) lên tới 3 lần cho câu bị thiếu.
 *    - Tự động mở chat mới giữa các batch và xử lý phục hồi khi chạm giới hạn độ dài.
 *    - Lưu & khôi phục phiên làm việc (Session state recovery).
 *    - Xuất file SRT hoàn chỉnh sau khi dịch 100%.
 *
 * BẢO ĐẢM NGUYÊN TẮC:
 * - Không sửa code gốc kagevietsub_mobile.user.js.
 * - Chạy độc lập, không tạo vòng lặp reload, không gửi trùng lặp.
 * ============================================================================
 */

(function () {
    'use strict';

    // Ngăn chặn chạy trùng lặp nếu script được nạp nhiều lần
    if (window.__KAGEVIETSUB_MOBILE_DESKTOP_ACTIVE__) {
        console.warn('[KageVietSub Mobile-Desktop] Script đã được nạp trước đó, bỏ qua khởi tạo trùng lặp.');
        return;
    }
    window.__KAGEVIETSUB_MOBILE_DESKTOP_ACTIVE__ = true;

    // =========================================================================
    // 1. CẤU HÌNH & HẰNG SỐ HỆ THỐNG
    // =========================================================================
    const CONFIG = {
        DEFAULT_BATCH_SIZE: 100,       // Mặc định 100 dòng/lô
        MAX_RETRIES: 3,                // Số lần thử lại tối đa cho mỗi đoạn nếu thiếu câu
        POLL_INTERVAL_MS: 800,         // Chu kỳ kiểm tra phản hồi của AI (ms)
        STABLE_CHECKS_REQUIRED: 3,     // Số lần nội dung không đổi liên tiếp để xác nhận AI đã xong
        SAFE_FULL_MODE_ITEMS: 300,     // Ngưỡng cảnh báo số lượng subtitle khi gửi toàn bộ
        SAFE_FULL_MODE_CHARS: 25000,   // Ngưỡng ký tự cảnh báo khi gửi toàn bộ
        STORAGE_KEY: 'kagevietsub_mobile_desktop_session',
        CONFIG_KEY_MODE: 'kg_pref_send_mode',
        CONFIG_KEY_BATCH: 'kg_pref_batch_size',
        DESKTOP_TARGET_WIDTH: 1280,    // Chiều rộng ép cho Desktop Mode trên mobile

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
        detectedEnvironment: null,
        isDesktopViewportActive: false
    };

    // =========================================================================
    // 2. MODULE NHẬN DIỆN THIẾT BỊ ĐA CHIỀU (DEVICE DETECTOR)
    // =========================================================================
    const DeviceDetector = {
        MODE_DESKTOP: 'DESKTOP',
        MODE_MOBILE: 'MOBILE',
        MODE_TABLET: 'TABLET',

        detect() {
            const ua = (navigator.userAgent || '').toLowerCase();
            const platform = (navigator.platform || '').toLowerCase();

            // 1. Kiểm tra khả năng cảm ứng (Touch capability)
            const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);

            // 2. Kiểm tra loại con trỏ (Coarse = màn cảm ứng, Fine = chuột)
            let isCoarse = false;
            try {
                isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            } catch (e) {}

            // 3. Kiểm tra User Agent di động & iPadOS
            const isMobileUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
            const isIpadOs = platform.includes('mac') && hasTouch && (navigator.maxTouchPoints > 1);

            // 4. Kích thước màn hình vật lý & Viewport
            const screenW = window.screen.width;
            const innerW = window.innerWidth;
            const isSmallScreen = innerW <= 768 || screenW <= 768;

            let deviceType = this.MODE_DESKTOP;
            if (hasTouch && (isMobileUa || isIpadOs || isCoarse || isSmallScreen)) {
                deviceType = this.MODE_MOBILE;
            } else if (hasTouch && (innerW > 768 && innerW <= 1024)) {
                deviceType = this.MODE_TABLET;
            } else if (!hasTouch && innerW > 1024) {
                deviceType = this.MODE_DESKTOP;
            } else {
                deviceType = isMobileUa ? this.MODE_MOBILE : this.MODE_DESKTOP;
            }

            currentSession.detectedEnvironment = deviceType;
            return {
                deviceType,
                hasTouch,
                isCoarse,
                isMobileUa,
                isIpadOs,
                screenWidth: screenW,
                viewportWidth: innerW,
                viewportHeight: window.innerHeight
            };
        },

        isDesktop() {
            if (!currentSession.detectedEnvironment) this.detect();
            return currentSession.detectedEnvironment === this.MODE_DESKTOP;
        },

        isMobile() {
            if (!currentSession.detectedEnvironment) this.detect();
            return currentSession.detectedEnvironment === this.MODE_MOBILE || currentSession.detectedEnvironment === this.MODE_TABLET;
        }
    };

    // =========================================================================
    // 3. MODULE QUẢN LÝ VIEWPORT & DESKTOP MODE (DESKTOP MODE MANAGER)
    // =========================================================================
    const DesktopModeManager = {
        originalContent: null,
        isCustomized: false,

        init() {
            const meta = document.querySelector('meta[name="viewport"]');
            if (meta) {
                this.originalContent = meta.getAttribute('content') || 'width=device-width, initial-scale=1.0';
            } else {
                this.originalContent = 'width=device-width, initial-scale=1.0';
            }
        },

        getMetaElement() {
            let meta = document.querySelector('meta[name="viewport"]');
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'viewport';
                document.head.appendChild(meta);
            }
            return meta;
        },

        applyDesktopViewport(targetWidth = CONFIG.DESKTOP_TARGET_WIDTH) {
            const meta = this.getMetaElement();
            if (!this.originalContent) {
                this.originalContent = meta.getAttribute('content') || 'width=device-width, initial-scale=1.0';
            }

            const currentScreenWidth = window.screen.width || 390;
            const targetScale = Math.max(0.25, Math.min(1.0, currentScreenWidth / targetWidth)).toFixed(2);
            const newContent = `width=${targetWidth}, initial-scale=${targetScale}, maximum-scale=3.0, user-scalable=yes`;

            meta.setAttribute('content', newContent);
            this.isCustomized = true;
            currentSession.isDesktopViewportActive = true;

            // Kích hoạt sự kiện resize giả để các component responsive cập nhật layout
            window.dispatchEvent(new Event('resize'));
            console.log(`%c[DesktopModeManager] Đã kích hoạt Desktop Mode (${targetWidth}px, scale=${targetScale})`, 'color: #00d2ff; font-weight: bold;');
            return { applied: true, newContent, scale: targetScale };
        },

        restoreOriginal() {
            if (!this.originalContent) return false;
            const meta = this.getMetaElement();
            meta.setAttribute('content', this.originalContent);
            this.isCustomized = false;
            currentSession.isDesktopViewportActive = false;
            window.dispatchEvent(new Event('resize'));
            console.log('[DesktopModeManager] Đã khôi phục Viewport ban đầu');
            return true;
        }
    };

    // =========================================================================
    // 4. BỘ ĐỆM LƯU TRỮ ĐA MÔI TRƯỜNG (STORAGE ADAPTER)
    // =========================================================================
    const StorageAdapter = {
        get(key, defaultValue) {
            try {
                if (typeof GM_getValue === 'function') {
                    const gmVal = GM_getValue(key, undefined);
                    if (gmVal !== undefined && gmVal !== null && gmVal !== '') {
                        return gmVal;
                    }
                }
            } catch (err) {}

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
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                }
            } catch (err) {}

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
    // 5. CÔNG CỤ XỬ LÝ SRT & KIỂM TRA CHẤT LƯỢNG (SRT MANAGER)
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

        if (transClean === origClean) {
            if (origHasChinese) {
                return { valid: false, reason: 'Chưa dịch (nguyên văn tiếng Trung)' };
            }
            return { valid: true, reason: 'OK' };
        }

        if (origHasChinese && containsChinese(transClean)) {
            return { valid: false, reason: 'Còn sót ký tự tiếng Trung' };
        }

        return { valid: true, reason: 'OK' };
    }

    function parseSrtContent(rawText) {
        const normalized = normalizeText(rawText);
        if (!normalized) return [];

        const blocks = normalized.split(/\n\s*\n/);
        const items = [];
        let autoId = 1;

        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            let timeIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('-->')) {
                    timeIdx = i;
                    break;
                }
            }

            if (timeIdx === -1) continue;

            let id = autoId;
            if (timeIdx > 0) {
                const parsedId = parseInt(lines[0], 10);
                if (!isNaN(parsedId)) id = parsedId;
            }

            const timeline = lines[timeIdx];
            const textLines = lines.slice(timeIdx + 1);
            const originalText = textLines.join(' ').trim();

            if (!originalText) continue;

            items.push({
                id: id,
                timeline: timeline,
                original: originalText,
                translated: '',
                status: 'pending' // pending | translated | failed
            });
            autoId++;
        }

        return items;
    }

    function buildFinalSrt(items) {
        const out = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const text = it.translated || it.original;
            out.push(`${i + 1}`);
            out.push(it.timeline);
            out.push(text);
            out.push('');
        }
        return out.join('\n');
    }

    // =========================================================================
    // 6. ĐIỀU PHỐI TƯƠNG TÁC DOM DEEPSEEK (DEEPSEEK CONTROLLER)
    // =========================================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function findChatInput() {
        const selectors = [
            'textarea#chat-input',
            'textarea[placeholder*="DeepSeek"]',
            'textarea[placeholder*="Message"]',
            'textarea[placeholder*="Gửi tin nhắn"]',
            'textarea',
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

    function setInputValue(inputEl, text) {
        if (!inputEl) return;
        inputEl.focus();

        if (inputEl.tagName.toLowerCase() === 'textarea') {
            const proto = window.HTMLTextAreaElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(inputEl, text);
            } else {
                inputEl.value = text;
            }
        } else {
            inputEl.innerText = text;
        }

        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function sendViaKeyboardEnter(inputEl) {
        if (!inputEl) return;
        inputEl.focus();

        const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
            view: window
        });

        const enterPress = new KeyboardEvent('keypress', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
            view: window
        });

        const enterUp = new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
            view: window
        });

        inputEl.dispatchEvent(enterDown);
        inputEl.dispatchEvent(enterPress);
        inputEl.dispatchEvent(enterUp);
    }

    function findSendButton() {
        const selectors = [
            'div[role="button"].ds-button--primary:not([disabled]):not([aria-disabled="true"])',
            'div[role="button"][class*="ds-button--primary"]:not([disabled]):not([aria-disabled="true"])',
            'div[role="button"][aria-label*="Send"]:not([disabled]):not([aria-disabled="true"])',
            'div[role="button"][aria-label*="Gửi"]:not([disabled]):not([aria-disabled="true"])',
            'button[type="submit"]:not([disabled])',
            'button:has(svg):not([disabled])'
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
    // 7. GỬI TIN NHẮN TƯƠNG THÍCH MÔI TRƯỜNG & THEO DÕI PHẢN HỒI
    // =========================================================================

    async function sendMessageAndWaitConfirmation(textToSend, maxWaitMs = 8000) {
        const input = findChatInput();
        if (!input) {
            throw new Error('Không tìm thấy khung nhập tin nhắn của DeepSeek.');
        }

        setInputValue(input, textToSend);
        await sleep(500);

        const baselineCount = getAssistantMessageCount();
        const isDesktopEnv = DeviceDetector.isDesktop();

        if (isDesktopEnv) {
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

        if (lastText) return lastText;
        throw new Error('Hết thời gian chờ phản hồi từ DeepSeek (Timeout).');
    }

    // =========================================================================
    // 8. BÓC TÁCH PHẢN HỒI & PHỤC HỒI DỮ LIỆU (RECOVERY & PARSING)
    // =========================================================================

    function cleanMarkdownCodeFences(text) {
        let cleaned = (text || '').replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
        cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
        return cleaned.trim();
    }

    function parseResponseToSubtitles(rawResponse, expectedItems) {
        const cleaned = cleanMarkdownCodeFences(rawResponse);
        const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
        const resultMap = new Map();
        const validIdSet = new Set(expectedItems.map(it => it.id));

        // 1. Quét theo định dạng chuẩn: #ID Bản dịch
        const stdRegex = /^#\s*(\d+)[\s:：\.\-]+(.*)$/;
        for (const line of lines) {
            const match = line.match(stdRegex);
            if (match) {
                const id = parseInt(match[1], 10);
                const trans = match[2].trim();
                if (validIdSet.has(id) && trans) {
                    resultMap.set(id, trans);
                }
            }
        }

        // 2. Fallback: Nếu AI trả về nguyên khối SRT
        if (resultMap.size < expectedItems.length) {
            const srtBlocks = cleaned.split(/\n\s*\n/);
            for (const b of srtBlocks) {
                const bLines = b.split('\n').map(l => l.trim()).filter(Boolean);
                if (bLines.length >= 2) {
                    let timeIdx = -1;
                    for (let i = 0; i < bLines.length; i++) {
                        if (bLines[i].includes('-->')) {
                            timeIdx = i;
                            break;
                        }
                    }
                    if (timeIdx > 0) {
                        const parsedId = parseInt(bLines[0], 10);
                        if (!isNaN(parsedId) && validIdSet.has(parsedId)) {
                            const transText = bLines.slice(timeIdx + 1).join(' ').trim();
                            if (transText && !resultMap.has(parsedId)) {
                                resultMap.set(parsedId, transText);
                            }
                        }
                    }
                }
            }
        }

        return resultMap;
    }

    function buildBatchPrompt(basePrompt, items) {
        const bodyLines = items.map(it => `#${it.id} ${it.original}`);
        return `${basePrompt}\n\n${bodyLines.join('\n')}`;
    }

    function buildRetryPrompt(basePrompt, missingItems) {
        const bodyLines = missingItems.map(it => `#${it.id} ${it.original}`);
        return `${basePrompt}\n\n[QUAN TRỌNG: CÁC CÂU SAU BỊ THIẾU HOẶC CHƯA ĐÚNG YÊU CẦU, HÃY DỊCH CHÍNH XÁC THEO ĐÚNG ĐỊNH DẠNG #ID NỘI_DUNG]:\n${bodyLines.join('\n')}`;
    }

    // =========================================================================
    // 9. QUY TRÌNH DỊCH TỪNG ĐOẠN & CƠ CHẾ SMART RETRY (TRANSLATION MANAGER)
    // =========================================================================

    async function processBatchWithRetries(batchItems, activePrompt, batchNum, totalBatches) {
        updateUIStatus(`Đang chuẩn bị gửi đoạn ${batchNum}/${totalBatches} (${batchItems.length} câu)...`);

        let promptToSend = buildBatchPrompt(activePrompt, batchItems);
        let retryCount = 0;

        while (retryCount <= CONFIG.MAX_RETRIES) {
            if (currentSession.stopRequested) return;

            updateUIStatus(`Đang gửi đoạn ${batchNum}/${totalBatches}${retryCount > 0 ? ` (Thử lại lần ${retryCount})` : ''}...`);

            try {
                const sent = await sendMessageAndWaitConfirmation(promptToSend, 10000);
                if (!sent) {
                    throw new Error('Gửi tin nhắn không thành công hoặc không nhận được phản hồi.');
                }

                updateUIStatus(`Đoạn ${batchNum}/${totalBatches}: Đang chờ DeepSeek trả lời...`);
                const responseText = await monitorAiResponse((partial) => {
                    updateUIStatus(`Đoạn ${batchNum}/${totalBatches}: DeepSeek đang sinh câu trả lời (${partial.length} ký tự)...`);
                });

                const parsedMap = parseResponseToSubtitles(responseText, batchItems);

                for (const it of batchItems) {
                    if (parsedMap.has(it.id)) {
                        const translatedCandidate = parsedMap.get(it.id);
                        const check = isTranslationValid(it.original, translatedCandidate);
                        if (check.valid) {
                            it.translated = translatedCandidate;
                            it.status = 'translated';
                            currentSession.lastCompletedItem = it;
                        }
                    }
                }

                updateSessionProgress();
                saveSessionToStorage();

                const missingItems = batchItems.filter(it => !it.translated || it.status !== 'translated');

                if (missingItems.length === 0) {
                    console.log(`[KageVietSub] Đoạn ${batchNum}/${totalBatches} hoàn thành xuất sắc 100%!`);
                    return;
                }

                // Nếu còn thiếu câu, thực hiện Retry
                retryCount++;
                if (retryCount <= CONFIG.MAX_RETRIES) {
                    updateUIStatus(`Đoạn ${batchNum}/${totalBatches}: Còn thiếu ${missingItems.length} câu. Đang thử lại (${retryCount}/${CONFIG.MAX_RETRIES})...`);
                    await sleep(2000);
                    promptToSend = buildRetryPrompt(activePrompt, missingItems);
                } else {
                    console.warn(`[KageVietSub] Đoạn ${batchNum}/${totalBatches} đã thử lại tối đa. Giữ lại câu gốc cho các mục chưa dịch.`);
                    for (const it of missingItems) {
                        it.translated = it.original;
                        it.status = 'failed';
                    }
                    updateSessionProgress();
                    saveSessionToStorage();
                    return;
                }

            } catch (err) {
                console.error(`[KageVietSub] Lỗi tại đoạn ${batchNum}:`, err);

                if (err.message === 'DEEPSEEK_LENGTH_LIMIT') {
                    updateUIStatus(`DeepSeek đạt giới hạn độ dài! Đang tự động mở cuộc trò chuyện mới để tiếp tục...`);
                    await sleep(1500);
                    await createNewChat();
                    await sleep(2000);

                    const remainingInBatch = batchItems.filter(it => !it.translated || it.status !== 'translated');
                    let recoveryHeader = activePrompt;
                    if (currentSession.lastCompletedItem) {
                        recoveryHeader += `\n\n[NGỮ CẢNH CÂU LIỀN TRƯỚC]: #${currentSession.lastCompletedItem.id} ${currentSession.lastCompletedItem.translated}`;
                    }
                    promptToSend = buildRetryPrompt(recoveryHeader, remainingInBatch);
                    continue;
                }

                retryCount++;
                if (retryCount <= CONFIG.MAX_RETRIES) {
                    updateUIStatus(`Lỗi kết nối hoặc AI ngắt quãng. Chờ 3s và thử lại (${retryCount}/${CONFIG.MAX_RETRIES})...`);
                    await sleep(3000);
                } else {
                    throw new Error(`Đoạn ${batchNum}/${totalBatches} thất bại sau ${CONFIG.MAX_RETRIES} lần thử: ${err.message || err}`);
                }
            }
        }
    }

    // =========================================================================
    // 10. ĐIỀU PHỐI TIẾN TRÌNH TOÀN CỤC & TẢI FILE
    // =========================================================================

    async function startTranslationProcess() {
        if (!currentSession.items || currentSession.items.length === 0) {
            alert('Vui lòng chọn file phụ đề SRT trước.');
            return;
        }

        // 1. Tự động kiểm tra môi trường & kích hoạt Desktop Mode trên Mobile
        const dev = DeviceDetector.detect();
        if (DeviceDetector.isMobile() && !DesktopModeManager.isCustomized) {
            updateUIStatus('Đang kích hoạt Desktop Mode (1280px)...');
            DesktopModeManager.applyDesktopViewport(CONFIG.DESKTOP_TARGET_WIDTH);
            await sleep(800);
        }

        // 2. Xác định Prompt AI sử dụng (In-memory tùy chỉnh hoặc Chuẩn PC)
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

    function stopTranslationProcess() {
        if (currentSession.isTranslating) {
            currentSession.stopRequested = true;
            updateUIStatus('Đang yêu cầu dừng tiến trình dịch...');
        }
    }

    function downloadTranslatedSrt() {
        if (!currentSession.items || currentSession.items.length === 0) return;

        const srtContent = buildFinalSrt(currentSession.items);
        const originalName = currentSession.fileName || 'subtitles.srt';
        const baseName = originalName.replace(/\.srt$/i, '');
        const outputFileName = `${baseName}_dich.srt`;

        const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outputFileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 2000);
    }

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
    // 11. LƯU & PHỤC HỒI TIẾN TRÌNH PHIÊN
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
            console.warn('[KageVietSub] Không thể lưu phiên làm việc:', e);
        }
    }

    function loadSessionFromStorage() {
        try {
            return StorageAdapter.get(CONFIG.STORAGE_KEY, null);
        } catch (e) {
            return null;
        }
    }

    function clearSessionStorage() {
        try {
            StorageAdapter.remove(CONFIG.STORAGE_KEY);
        } catch (e) {}
    }

    // =========================================================================
    // 12. GIAO DIỆN ĐIỀU KHIỂN NỔI (UI CONTROLLER & RESPONSIVE DASHBOARD)
    // =========================================================================

    let uiElements = {};

    function injectUI() {
        if (document.getElementById('kagevietsub-mobile-desktop-panel')) return;

        loadUserConfig();
        DesktopModeManager.init();
        DeviceDetector.detect();

        // Tự động kích hoạt Desktop Mode trên Mobile ngay khi mở trang
        if (DeviceDetector.isMobile()) {
            DesktopModeManager.applyDesktopViewport(CONFIG.DESKTOP_TARGET_WIDTH);
        }

        const container = document.createElement('div');
        container.id = 'kagevietsub-mobile-desktop-panel';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 350px;
            max-width: calc(100vw - 28px);
            background: #181920;
            border: 1px solid #2e384d;
            border-radius: 12px;
            box-shadow: 0 10px 32px rgba(0, 0, 0, 0.75);
            color: #e2e8f0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            z-index: 9999999;
            box-sizing: border-box;
            overflow: hidden;
            transition: all 0.25s ease;
        `;

        const isMobileEnv = DeviceDetector.isMobile();
        const envBadgeText = isMobileEnv ? '📱 MOBILE' : '🖥️ DESKTOP';
        const envBadgeColor = isMobileEnv ? '#f59e0b' : '#10b981';

        container.innerHTML = `
            <div id="kg-header" style="
                background: #202433;
                padding: 10px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid #2e384d;
                cursor: move;
                user-select: none;
            ">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 700; color: #00d2ff; font-size: 13px;">KAGEVIETSUB TRANSLATOR</span>
                    <span id="kg-env-badge" style="
                        font-size: 10px;
                        font-weight: 700;
                        padding: 1px 6px;
                        border-radius: 10px;
                        background: rgba(255,255,255,0.1);
                        color: ${envBadgeColor};
                        border: 1px solid ${envBadgeColor};
                    ">${envBadgeText}</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <button id="kg-vp-toggle-btn" title="Chuyển đổi Viewport Desktop (1280px) / Nguyên bản" style="
                        background: #2a3346;
                        border: 1px solid #3e4c66;
                        color: #93c5fd;
                        border-radius: 6px;
                        padding: 2px 6px;
                        font-size: 11px;
                        cursor: pointer;
                        font-weight: 600;
                    ">${DesktopModeManager.isCustomized ? '1280px' : 'Auto'}</button>
                    <button id="kg-minimize-btn" style="
                        background: transparent;
                        border: 1px solid #3b4760;
                        color: #94a3b8;
                        border-radius: 6px;
                        width: 24px;
                        height: 24px;
                        cursor: pointer;
                        font-size: 14px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">−</button>
                </div>
            </div>

            <div id="kg-body" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; max-height: 80vh; overflow-y: auto;">
                <!-- Nút chọn file SRT -->
                <label style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #252836;
                    border: 1px dashed #4e8cff;
                    border-radius: 8px;
                    padding: 10px;
                    color: #4e8cff;
                    font-weight: 600;
                    cursor: pointer;
                    min-height: 42px;
                    text-align: center;
                ">
                    📂 [ Chọn file SRT ]
                    <input type="file" id="kg-file-input" accept=".srt" style="display: none;" />
                </label>

                <!-- Thông tin file đã chọn -->
                <div id="kg-file-meta" style="
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    background: #1c202b;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid #2b3547;
                ">
                    <div id="kg-filename-label" style="font-size: 12px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        Tên file: <span style="color: #ffffff; font-weight: 500;">(Chưa chọn)</span>
                    </div>
                    <div id="kg-total-count-label" style="font-size: 12px; color: #94a3b8;">
                        Tổng phụ đề: <span style="color: #ffffff; font-weight: 500;">0 dòng</span>
                    </div>
                </div>

                <!-- Cấu hình Chế độ gửi -->
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase;">Chế độ gửi:</label>
                    <select id="kg-mode-select" style="
                        background: #1c202b;
                        color: #ffffff;
                        border: 1px solid #3b4760;
                        border-radius: 6px;
                        padding: 8px 10px;
                        font-size: 13px;
                        cursor: pointer;
                        min-height: 38px;
                        outline: none;
                    ">
                        <option value="lines">Gửi theo số dòng ▼</option>
                        <option value="all">Gửi toàn bộ SRT</option>
                    </select>
                </div>

                <!-- Cấu hình Số dòng mỗi lần gửi -->
                <div id="kg-batch-container" style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 11px; color: #94a3b8; font-weight: 600; text-transform: uppercase;">Số dòng mỗi lần:</label>
                    <div style="display: flex; gap: 6px;">
                        <select id="kg-batch-select" style="
                            flex: 1;
                            background: #1c202b;
                            color: #ffffff;
                            border: 1px solid #3b4760;
                            border-radius: 6px;
                            padding: 8px 10px;
                            font-size: 13px;
                            cursor: pointer;
                            min-height: 38px;
                            outline: none;
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
                            background: #1c202b;
                            color: #ffffff;
                            border: 1px solid #00d2ff;
                            border-radius: 6px;
                            padding: 6px 8px;
                            font-size: 13px;
                            outline: none;
                        " />
                    </div>
                </div>

                <!-- PROMPT AI TÙY CHỌN (In-memory) -->
                <div style="border: 1px solid #2b3547; border-radius: 6px; overflow: hidden; background: #1c202b;">
                    <div id="kg-prompt-header" style="
                        padding: 7px 10px;
                        background: #232938;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 600;
                        color: #cbd5e1;
                    ">
                        <span>PROMPT AI (Tùy chọn)</span>
                        <span id="kg-prompt-toggle-btn" style="color: #00d2ff; font-weight: bold;">+</span>
                    </div>
                    <div id="kg-prompt-body" style="display: none; padding: 10px; flex-direction: column; gap: 8px;">
                        <textarea id="kg-custom-prompt-input" placeholder="Để trống để dùng Prompt gốc của tool PC. Nhập prompt tại đây để thay thế hoàn toàn trong phiên hiện tại..." style="
                            width: 100%;
                            min-height: 75px;
                            max-height: 150px;
                            background: #14171f;
                            color: #f1f5f9;
                            border: 1px solid #3b4760;
                            border-radius: 6px;
                            padding: 6px 8px;
                            font-size: 11px;
                            font-family: inherit;
                            outline: none;
                            box-sizing: border-box;
                            resize: vertical;
                        "></textarea>
                        <button id="kg-download-sample-prompt-btn" style="
                            background: #2a3346;
                            color: #93c5fd;
                            border: 1px solid #3e4c66;
                            border-radius: 6px;
                            padding: 6px 10px;
                            font-size: 11px;
                            font-weight: 600;
                            cursor: pointer;
                            text-align: center;
                        ">📥 [ TẢI PROMPT MẪU (.TXT) ]</button>
                    </div>
                </div>

                <!-- Nút Bắt đầu / Dừng -->
                <button id="kg-start-btn" disabled style="
                    background: linear-gradient(135deg, #0070f3, #00d2ff);
                    color: #ffffff;
                    border: none;
                    border-radius: 8px;
                    padding: 12px;
                    font-weight: 700;
                    font-size: 14px;
                    cursor: pointer;
                    min-height: 44px;
                    opacity: 0.5;
                    transition: opacity 0.2s ease;
                ">[ BẮT ĐẦU DỊCH ]</button>

                <button id="kg-stop-btn" style="
                    display: none;
                    background: #dc2626;
                    color: #ffffff;
                    border: none;
                    border-radius: 8px;
                    padding: 10px;
                    font-weight: 700;
                    font-size: 13px;
                    cursor: pointer;
                    min-height: 40px;
                ">[ DỪNG DỊCH ]</button>

                <!-- Phục hồi phiên dịch cũ (nếu có) -->
                <div id="kg-resume-banner" style="
                    display: none;
                    flex-direction: column;
                    gap: 6px;
                    background: #242c16;
                    border: 1px solid #4d661e;
                    padding: 8px 10px;
                    border-radius: 6px;
                ">
                    <div style="font-size: 12px; color: #bef264;">Phát hiện phiên dịch chưa xong!</div>
                    <div style="display: flex; gap: 6px;">
                        <button id="kg-resume-btn" style="
                            flex: 1;
                            background: #65a30d;
                            color: #ffffff;
                            border: none;
                            border-radius: 4px;
                            padding: 6px;
                            font-size: 11px;
                            font-weight: 600;
                            cursor: pointer;
                        ">Tiếp tục dịch</button>
                        <button id="kg-discard-btn" style="
                            background: #475569;
                            color: #e2e8f0;
                            border: none;
                            border-radius: 4px;
                            padding: 6px 10px;
                            font-size: 11px;
                            cursor: pointer;
                        ">Hủy bỏ</button>
                    </div>
                </div>

                <hr style="border: 0; border-top: 1px solid #2e384d; margin: 2px 0;" />

                <!-- Tiến trình -->
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8;">
                    <span>Tiến trình:</span>
                    <span id="kg-progress-text" style="color: #ffffff; font-weight: 600;">0%</span>
                </div>

                <div style="background: #232938; height: 8px; border-radius: 4px; overflow: hidden;">
                    <div id="kg-progress-bar" style="background: linear-gradient(90deg, #0070f3, #00d2ff); width: 0%; height: 100%; transition: width 0.3s ease;"></div>
                </div>

                <!-- Dòng trạng thái -->
                <div id="kg-status-label" style="
                    font-size: 11px;
                    color: #94a3b8;
                    min-height: 18px;
                    line-height: 1.4;
                    word-break: break-word;
                ">Đang chờ bắt đầu...</div>
            </div>
        `;

        document.body.appendChild(container);

        // Lưu tham chiếu DOM
        uiElements = {
            panel: container,
            header: document.getElementById('kg-header'),
            body: document.getElementById('kg-body'),
            minimizeBtn: document.getElementById('kg-minimize-btn'),
            vpToggleBtn: document.getElementById('kg-vp-toggle-btn'),
            fileInput: document.getElementById('kg-file-input'),
            fileNameLabel: document.getElementById('kg-filename-label'),
            totalCountLabel: document.getElementById('kg-total-count-label'),
            modeSelect: document.getElementById('kg-mode-select'),
            batchContainer: document.getElementById('kg-batch-container'),
            batchSelect: document.getElementById('kg-batch-select'),
            batchCustomInput: document.getElementById('kg-batch-custom-input'),
            startBtn: document.getElementById('kg-start-btn'),
            stopBtn: document.getElementById('kg-stop-btn'),
            progressBar: document.getElementById('kg-progress-bar'),
            progressText: document.getElementById('kg-progress-text'),
            statusLabel: document.getElementById('kg-status-label'),
            promptHeader: document.getElementById('kg-prompt-header'),
            promptBody: document.getElementById('kg-prompt-body'),
            promptToggleBtn: document.getElementById('kg-prompt-toggle-btn'),
            customPromptInput: document.getElementById('kg-custom-prompt-input'),
            downloadSamplePromptBtn: document.getElementById('kg-download-sample-prompt-btn')
        };

        initUIEvents();
        checkAndPromptResumeSession();
    }

    function initUIEvents() {
        // 1. Kéo thả bảng điều khiển
        let isDragging = false;
        let startX, startY, initLeft, initTop;

        uiElements.header.addEventListener('mousedown', (e) => {
            if (e.target.tagName.toLowerCase() === 'button') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = uiElements.panel.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
            uiElements.panel.style.bottom = 'auto';
            uiElements.panel.style.right = 'auto';
            uiElements.panel.style.left = `${initLeft}px`;
            uiElements.panel.style.top = `${initTop}px`;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            uiElements.panel.style.left = `${Math.max(10, Math.min(window.innerWidth - 360, initLeft + dx))}px`;
            uiElements.panel.style.top = `${Math.max(10, Math.min(window.innerHeight - 80, initTop + dy))}px`;
        });

        document.addEventListener('mouseup', () => { isDragging = false; });

        // Hỗ trợ cảm ứng kéo thả trên Mobile
        uiElements.header.addEventListener('touchstart', (e) => {
            if (e.target.tagName.toLowerCase() === 'button') return;
            const touch = e.touches[0];
            isDragging = true;
            startX = touch.clientX;
            startY = touch.clientY;
            const rect = uiElements.panel.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
            uiElements.panel.style.bottom = 'auto';
            uiElements.panel.style.right = 'auto';
            uiElements.panel.style.left = `${initLeft}px`;
            uiElements.panel.style.top = `${initTop}px`;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            uiElements.panel.style.left = `${Math.max(10, Math.min(window.innerWidth - 360, initLeft + dx))}px`;
            uiElements.panel.style.top = `${Math.max(10, Math.min(window.innerHeight - 80, initTop + dy))}px`;
        }, { passive: true });

        document.addEventListener('touchend', () => { isDragging = false; });

        // 2. Nút Thu nhỏ / Phóng to
        let isMin = false;
        uiElements.minimizeBtn.onclick = () => {
            isMin = !isMin;
            uiElements.body.style.display = isMin ? 'none' : 'flex';
            uiElements.minimizeBtn.innerText = isMin ? '+' : '−';
            uiElements.panel.style.width = isMin ? '220px' : '350px';
        };

        // 3. Nút Toggle Viewport Desktop Mode (1280px vs Native)
        uiElements.vpToggleBtn.onclick = () => {
            if (DesktopModeManager.isCustomized) {
                DesktopModeManager.restoreOriginal();
                uiElements.vpToggleBtn.innerText = 'Auto';
                uiElements.vpToggleBtn.style.color = '#94a3b8';
            } else {
                DesktopModeManager.applyDesktopViewport(CONFIG.DESKTOP_TARGET_WIDTH);
                uiElements.vpToggleBtn.innerText = '1280px';
                uiElements.vpToggleBtn.style.color = '#00d2ff';
            }
        };

        // 4. Khôi phục cấu hình từ bộ nhớ
        uiElements.modeSelect.value = userSettings.mode;
        if (userSettings.mode === 'all') {
            uiElements.batchContainer.style.display = 'none';
        }

        const presets = ['20', '50', '100', '200', '300'];
        if (presets.includes(String(userSettings.batchSize))) {
            uiElements.batchSelect.value = String(userSettings.batchSize);
            uiElements.batchCustomInput.style.display = 'none';
        } else {
            uiElements.batchSelect.value = 'custom';
            uiElements.batchCustomInput.style.display = 'block';
            uiElements.batchCustomInput.value = userSettings.batchSize;
        }

        // 5. Sự kiện thay đổi chế độ gửi
        uiElements.modeSelect.onchange = (e) => {
            const val = e.target.value;
            userSettings.mode = val;
            if (val === 'all') {
                uiElements.batchContainer.style.display = 'none';
            } else {
                uiElements.batchContainer.style.display = 'flex';
            }
            saveUserConfig(userSettings.mode, userSettings.batchSize);
        };

        // 6. Sự kiện thay đổi số dòng
        uiElements.batchSelect.onchange = (e) => {
            const val = e.target.value;
            if (val === 'custom') {
                uiElements.batchCustomInput.style.display = 'block';
                uiElements.batchCustomInput.focus();
            } else {
                uiElements.batchCustomInput.style.display = 'none';
                userSettings.batchSize = parseInt(val, 10);
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        };

        uiElements.batchCustomInput.onchange = (e) => {
            const num = parseInt(e.target.value, 10);
            if (!isNaN(num) && num >= 5) {
                userSettings.batchSize = num;
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        };

        // 7. Khu vực Prompt AI
        let isPromptOpen = false;
        uiElements.promptHeader.onclick = () => {
            isPromptOpen = !isPromptOpen;
            uiElements.promptBody.style.display = isPromptOpen ? 'flex' : 'none';
            uiElements.promptToggleBtn.innerText = isPromptOpen ? '−' : '+';
        };

        uiElements.downloadSamplePromptBtn.onclick = () => {
            downloadSamplePrompt();
        };

        // 8. Chọn file SRT
        uiElements.fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target.result;
                const items = parseSrtContent(content);

                if (items.length === 0) {
                    alert('Không tìm thấy phụ đề hợp lệ trong file SRT.');
                    return;
                }

                currentSession.fileName = file.name;
                currentSession.items = items;
                currentSession.currentBatchIndex = 0;
                currentSession.totalBatches = 0;
                currentSession.lastCompletedItem = null;

                uiElements.fileNameLabel.innerHTML = `Tên file: <span style="color: #ffffff; font-weight: 600;">${file.name}</span>`;
                uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span style="color: #ffffff; font-weight: 600;">${items.length.toLocaleString('vi-VN')} dòng</span>`;

                uiElements.startBtn.disabled = false;
                uiElements.startBtn.style.opacity = '1';

                updateUIStatus(`Đã nạp file thành công (${items.length.toLocaleString('vi-VN')} dòng). Sẵn sàng dịch!`);
                updateProgress(0, items.length);
            };

            reader.readAsText(file, 'UTF-8');
        };

        // 9. Nút Bắt đầu & Dừng
        uiElements.startBtn.onclick = () => {
            startTranslationProcess();
        };

        uiElements.stopBtn.onclick = () => {
            stopTranslationProcess();
        };
    }

    function updateUIStatus(text) {
        if (uiElements.statusLabel) {
            uiElements.statusLabel.innerText = text;
        }
        console.log(`[KageVietSub Status] ${text}`);
    }

    function updateProgress(doneCount, totalCount) {
        if (!uiElements.progressBar || !uiElements.progressText) return;
        const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
        uiElements.progressBar.style.width = `${pct}%`;
        uiElements.progressText.innerText = `${pct}% (${doneCount}/${totalCount})`;
    }

    function updateSessionProgress() {
        if (!currentSession.items) return;
        const total = currentSession.items.length;
        const done = currentSession.items.filter(it => it.translated && it.status === 'translated').length;
        updateProgress(done, total);
    }

    function updateUIState(isTranslating) {
        if (!uiElements.startBtn || !uiElements.stopBtn) return;
        if (isTranslating) {
            uiElements.startBtn.style.display = 'none';
            uiElements.stopBtn.style.display = 'block';
            uiElements.fileInput.disabled = true;
            uiElements.modeSelect.disabled = true;
            uiElements.batchSelect.disabled = true;
            uiElements.batchCustomInput.disabled = true;
        } else {
            uiElements.startBtn.style.display = 'block';
            uiElements.stopBtn.style.display = 'none';
            uiElements.fileInput.disabled = false;
            uiElements.modeSelect.disabled = false;
            uiElements.batchSelect.disabled = false;
            uiElements.batchCustomInput.disabled = false;
        }
    }

    function checkAndPromptResumeSession() {
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
                            lastCompletedItem: null,
                            detectedEnvironment: null,
                            isDesktopViewportActive: DesktopModeManager.isCustomized
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
        setTimeout(injectUI, 1000);
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectUI, 800);
    }

})();
