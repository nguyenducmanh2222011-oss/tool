// ==UserScript==
// @name         KAGEVIETSUB Mobile Translator (Clean & Reconstructed)
// @namespace    https://kagevietsub.com/
// @version      1.2.0
// @description  Tự động dịch file phụ đề SRT Trung - Việt bằng DeepSeek trên PC và trình duyệt điện thoại (Bản mã nguồn mở đã gỡ VM).
// @author       KageVietSub (Reconstructed)
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
    // 1. CẤU HÌNH HỆ THỐNG & TRẠNG THÁI
    // =========================================================================
    const ALGORITHM_CONFIG = {
        DEFAULT_BATCH_SIZE: 100,
        MAX_RETRIES: 3,
        SAFE_FULL_MODE_ITEMS: 200,
        SAFE_FULL_MODE_CHARS: 6000
    };

    function getAlgorithmConfig(key) {
        return ALGORITHM_CONFIG[key];
    }

    const CONFIG = {
        get DEFAULT_BATCH_SIZE() {
            return getAlgorithmConfig('DEFAULT_BATCH_SIZE');
        },
        get MAX_RETRIES() {
            return getAlgorithmConfig('MAX_RETRIES');
        },
        POLL_INTERVAL_MS: 800,
        STABLE_CHECKS_REQUIRED: 3,
        get SAFE_FULL_MODE_ITEMS() {
            return getAlgorithmConfig('SAFE_FULL_MODE_ITEMS');
        },
        get SAFE_FULL_MODE_CHARS() {
            return getAlgorithmConfig('SAFE_FULL_MODE_CHARS');
        },
        STORAGE_KEY: 'kagevietsub_mobile_session',
        CONFIG_KEY_MODE: 'kg_pref_send_mode',
        CONFIG_KEY_BATCH: 'kg_pref_batch_size'
    };

    const CHINESE_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
    const CHINESE_GLOBAL_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

    let userSettings = {
        mode: 'lines',
        batchSize: 100
    };

    let currentSession = {
        fileName: '',
        items: [],
        isTranslating: false,
        stopRequested: false,
        currentBatchIndex: 0,
        totalBatches: 0,
        lastCompletedItem: null,
        detectedEnvironment: null
    };

    // =========================================================================
    // 2. NHẬN DIỆN THIẾT BỊ & LƯU TRỮ (STORAGE ADAPTER)
    // =========================================================================
    const DeviceCompatibilityManager = {
        MODE_DESKTOP: 'DESKTOP',
        MODE_MOBILE: 'MOBILE',
        currentMode: null,

        detect() {
            const telemetry = BrowserAdapter.getTelemetry();
            this.currentMode = detectDeviceType(telemetry);
            currentSession.detectedEnvironment = this.currentMode;
            console.log(`%c[DeviceCompatibilityManager] Môi trường xác định: ${this.currentMode} (touch=${telemetry.hasTouch}, coarsePointer=${telemetry.isCoarse}, viewport=${telemetry.innerWidth}x${telemetry.innerHeight})`, 'color: #00d2ff; font-weight: bold;');
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
        const conf = loadUserConfigLogic(rawMode, rawBatch);
        userSettings.mode = conf.mode;
        userSettings.batchSize = conf.batchSize;
    }

    function saveUserConfig(mode, batchSize) {
        const conf = saveUserConfigLogic(mode, batchSize);
        userSettings.mode = conf.mode;
        userSettings.batchSize = conf.batchSize;
        StorageAdapter.set(CONFIG.CONFIG_KEY_MODE, conf.storageMode);
        StorageAdapter.set(CONFIG.CONFIG_KEY_BATCH, conf.storageBatch);
    }

    // =========================================================================
    // 3. CÁC HÀM LOGIC CỐT LÕI (ĐÃ ĐƯỢC TÁI TẠO TỪ _0xvm)
    // =========================================================================

    function normalizeTimeline(timelineStr) {
        if (!timelineStr) return '';
        return String(timelineStr)
            .trim()
            .replace(/\s*-->\s*/, ' --> ')
            .replace(/\./g, ',');
    }

    function cleanMarkdown(raw) {
        if (!raw) return '';
        return String(raw)
            .replace(/^```[a-zA-Z]*\s*\n?/gm, '')
            .replace(/```$/gm, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .trim();
    }

    function normalizeText(text) {
        if (!text) return '';
        return cleanMarkdown(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function containsChinese(text) {
        if (!text) return false;
        return CHINESE_REGEX.test(String(text));
    }

    function countChinese(text) {
        if (!text) return 0;
        const matches = String(text).match(CHINESE_GLOBAL_REGEX);
        return matches ? matches.length : 0;
    }

    function isTranslationValid(original, translated) {
        if (!translated || typeof translated !== 'string') return false;
        const cleanTrans = normalizeText(translated);
        if (!cleanTrans) return false;
        // Nếu câu gốc có tiếng Trung nhưng bản dịch vẫn còn sót ký tự tiếng Trung thì coi là chưa hợp lệ
        if (containsChinese(original) && containsChinese(cleanTrans)) {
            return false;
        }
        return true;
    }

    function calculateBatches(items, mode, batchSize) {
        const list = Array.isArray(items) ? items : [];
        const size = (mode === 'all') ? Math.max(1, list.length) : validateBatchSize(batchSize);
        const batches = [];
        for (let i = 0; i < list.length; i += size) {
            batches.push({
                batchIndex: batches.length,
                items: list.slice(i, i + size)
            });
        }
        return {
            totalBatches: batches.length,
            batches: batches
        };
    }

    function getDefaultPrompt() {
        return [
            'Bạn là một biên dịch viên phụ đề phim Trung - Việt chuyên nghiệp.',
            'Nhiệm vụ: Dịch các dòng phụ đề dưới đây từ tiếng Trung sang tiếng Việt tự nhiên, mượt mà, đúng ngữ cảnh phim.',
            'QUY TẮC BẮT BUỘC:',
            '1. Giữ nguyên định dạng đánh số đầu dòng: [ID] Nội dung dịch',
            '2. Dịch đầy đủ 100% số câu, tuyệt đối không gộp câu, không bỏ sót câu nào.',
            '3. Không để sót bất kỳ chữ Hán nào trong bản dịch.',
            '4. Chỉ trả về danh sách các câu đã dịch theo đúng định dạng [ID] Nội dung, không giải thích hay bình luận thêm.'
        ].join('\n');
    }

    function getSamplePromptText() {
        return getDefaultPrompt() + '\n\n--- GỢI Ý TÙY CHỈNH ---\n- Thể loại phim: Tiên hiệp / Cổ trang / Hiện đại...\n- Xưng hô: Ta - Ngươi / Huynh - Muội / Anh - Em...';
    }

    function buildBatchPrompt(activePrompt, batchItems) {
        const header = (activePrompt || getDefaultPrompt()).trim();
        const lines = batchItems.map(it => `[${it.id}] ${it.original.replace(/\n+/g, ' ')}`);
        return `${header}\n\nDữ liệu cần dịch:\n${lines.join('\n')}`;
    }

    function buildRetryPrompt(missingItems) {
        const lines = missingItems.map(it => `[${it.id}] ${it.original.replace(/\n+/g, ' ')}`);
        return [
            'Bạn còn dịch thiếu hoặc để sót chữ Hán ở các câu dưới đây.',
            'Hãy dịch lại CHÍNH XÁC và ĐẦY ĐỦ các câu này sang tiếng Việt theo đúng định dạng [ID] Nội dung dịch (không giải thích thêm):',
            '',
            lines.join('\n')
        ].join('\n');
    }

    function buildRecoveryPrompt(activePrompt, contextItem, missingItems) {
        const header = (activePrompt || getDefaultPrompt()).trim();
        const contextBlock = contextItem
            ? `\nNgữ cảnh câu vừa dịch trước đó:\n[${contextItem.id}] Gốc: ${contextItem.original} -> Dịch: ${contextItem.translated}\n`
            : '';
        const lines = missingItems.map(it => `[${it.id}] ${it.original.replace(/\n+/g, ' ')}`);
        return `${header}${contextBlock}\nHãy tiếp tục dịch các câu còn lại dưới đây theo đúng định dạng [ID] Nội dung dịch:\n${lines.join('\n')}`;
    }

    function parseSrtContent(content) {
        if (!content || typeof content !== 'string') return [];
        const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const blocks = normalized.split(/\n{2,}/);
        const items = [];

        for (let i = 0; i < blocks.length; i++) {
            const lines = blocks[i].split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            let idLineIdx = 0;
            let timeLineIdx = 1;

            if (lines[0].includes('-->')) {
                timeLineIdx = 0;
                idLineIdx = -1;
            } else if (!lines[1].includes('-->')) {
                continue;
            }

            const rawId = idLineIdx >= 0 ? parseInt(lines[idLineIdx], 10) : (items.length + 1);
            const id = !isNaN(rawId) ? rawId : (items.length + 1);
            const timeline = normalizeTimeline(lines[timeLineIdx]);
            const original = lines.slice(timeLineIdx + 1).join('\n').trim();

            if (!original) continue;

            items.push({
                id: id,
                timeline: timeline,
                original: original,
                translated: '',
                status: 'pending'
            });
        }
        return items;
    }

    function parseAiResponse(rawText, expectedInput) {
        const resultMap = new Map();
        if (!rawText || typeof rawText !== 'string') return resultMap;

        let validIds = null;
        if (expectedInput instanceof Set) {
            validIds = expectedInput;
        } else if (Array.isArray(expectedInput)) {
            validIds = new Set(expectedInput.map(it => (typeof it === 'object' ? it.id : Number(it))));
        }

        const cleaned = cleanMarkdown(rawText);
        const lines = cleaned.split('\n');

        // Hỗ trợ cả định dạng [12] Nội dung, 12. Nội dung, hoặc định dạng SRT
        const bracketRegex = /^\s*\[?(\d+)\]?[\s.:：\-]+(.+)$/;

        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            if (!line) {
                i++;
                continue;
            }

            // Trường hợp AI trả về dạng khối SRT có chứa timeline
            if (/^\d+$/.test(line) && i + 1 < lines.length && lines[i + 1].includes('-->')) {
                const id = parseInt(line, 10);
                i += 2;
                const textLines = [];
                while (i < lines.length && lines[i].trim() !== '' && !(/^\d+$/.test(lines[i].trim()) && i + 1 < lines.length && lines[i + 1].includes('-->'))) {
                    textLines.push(lines[i].trim());
                    i++;
                }
                const trans = normalizeText(textLines.join('\n'));
                if (trans && (!validIds || validIds.has(id))) {
                    resultMap.set(id, trans);
                }
                continue;
            }

            // Trường hợp chuẩn: [ID] Nội dung dịch
            const match = line.match(bracketRegex);
            if (match) {
                const id = parseInt(match[1], 10);
                const trans = normalizeText(match[2]);
                if (trans && (!validIds || validIds.has(id))) {
                    resultMap.set(id, trans);
                }
            }
            i++;
        }

        return resultMap;
    }

    function validateTranslationResults(expectedItems, parsedResultMap) {
        if (!Array.isArray(expectedItems) || !parsedResultMap) return 0;
        let updatedCount = 0;

        for (const item of expectedItems) {
            const candidate = parsedResultMap instanceof Map ? parsedResultMap.get(item.id) : parsedResultMap[item.id];
            if (candidate && isTranslationValid(item.original, candidate)) {
                item.translated = normalizeText(candidate);
                item.status = 'completed';
                currentSession.lastCompletedItem = item;
                updatedCount++;
            }
        }
        return updatedCount;
    }

    function filterMissingItems(items) {
        if (!Array.isArray(items)) return [];
        return items.filter(it => !it.translated || it.status !== 'completed' || !isTranslationValid(it.original, it.translated));
    }

    function applyRecoveryResults(batchItems, parsedResults, contextItemId) {
        return validateTranslationResults(batchItems, parsedResults);
    }

    function validateFinalExport(items) {
        if (!Array.isArray(items) || items.length === 0) {
            return { valid: false, reason: 'Danh sách phụ đề trống.' };
        }
        const missing = filterMissingItems(items);
        if (missing.length > 0) {
            return { valid: false, reason: `Còn ${missing.length} câu chưa được dịch hợp lệ.` };
        }
        return { valid: true };
    }

    function buildCompleteSrtContent(items) {
        return items.map((it, idx) => {
            const id = it.id || (idx + 1);
            const text = normalizeText(it.translated || it.original);
            return `${id}\n${it.timeline}\n${text}`;
        }).join('\n\n') + '\n';
    }

    function initBatchState(items) {
        if (!Array.isArray(items)) return;
        for (const it of items) {
            if (it.translated && isTranslationValid(it.original, it.translated)) {
                it.status = 'completed';
            } else {
                it.translated = '';
                it.status = 'pending';
            }
        }
    }

    function evaluateBatchProgress(batchItems, maxRetries, currentAttempt) {
        const missing = filterMissingItems(batchItems);
        const isComplete = missing.length === 0;
        return {
            isComplete: isComplete,
            missingCount: missing.length,
            statusMessage: isComplete
                ? 'Đã hoàn thành đoạn hiện tại.'
                : `Đang dịch bù ${missing.length} câu còn thiếu (Lần thử ${currentAttempt}/${maxRetries})...`
        };
    }

    function detectDeviceType(telemetry) {
        if (!telemetry) return 'DESKTOP';
        const isMobileUA = /android|iphone|ipad|ipod|mobile|iemobile|opera mini/i.test(telemetry.ua || '');
        if (isMobileUA || (telemetry.hasTouch && telemetry.isCoarse && telemetry.innerWidth <= 900)) {
            return 'MOBILE';
        }
        return 'DESKTOP';
    }

    // =========================================================================
    // 4. BỘ TƯƠNG TÁC DOM DEEPSEEK (DOM ADAPTER LOGIC)
    // =========================================================================

    function findChatInputElement(adapter) {
        const selectors = [
            'textarea#chat-input',
            'textarea[placeholder]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea'
        ];
        for (const sel of selectors) {
            const el = adapter.query(sel);
            if (el && adapter.isVisible(el) && !el.closest('#kagevietsub-mobile-widget')) {
                return el;
            }
        }
        return null;
    }

    function findSendButtonElement(adapter, chatInput) {
        const container = (chatInput && adapter.closest(chatInput, 'div._24fad49, form, main')) || document;
        const buttons = adapter.queryAll('div[role="button"], button', container);

        for (let i = buttons.length - 1; i >= 0; i--) {
            const btn = buttons[i];
            if (!adapter.isVisible(btn) || adapter.isDisabled(btn)) continue;
            if (btn.closest('#kagevietsub-mobile-widget')) continue;
            const svgInfo = adapter.getSvgInfo(btn);
            if (svgInfo && svgInfo.pathD) {
                return btn;
            }
        }
        return null;
    }

    function findNewChatButtonElement(adapter) {
        const candidates = adapter.queryAll('div[role="button"], button, a');
        for (const el of candidates) {
            if (!adapter.isVisible(el) || el.closest('#kagevietsub-mobile-widget')) continue;
            const text = adapter.getText(el).toLowerCase();
            if (text.includes('new chat') || text.includes('cuộc trò chuyện mới') || text.includes('开启新对话')) {
                return el;
            }
        }
        // Fallback: tìm nút có icon dấu cộng trên thanh điều hướng của DeepSeek
        for (const el of candidates) {
            if (!adapter.isVisible(el) || el.closest('#kagevietsub-mobile-widget')) continue;
            const svg = adapter.getSvgInfo(el);
            if (svg && (svg.pathD.includes('M12 4') || svg.pathD.includes('M7.5') || el.className.includes('ds-button'))) {
                const rect = el.getBoundingClientRect();
                if (rect.top < 150) return el;
            }
        }
        return null;
    }

    function checkAiGenerating(adapter) {
        const buttons = adapter.queryAll('div[role="button"], button');
        for (const btn of buttons) {
            if (!adapter.isVisible(btn) || btn.closest('#kagevietsub-mobile-widget')) continue;
            const text = adapter.getText(btn).toLowerCase();
            if (text === 'stop' || text.includes('dừng')) return true;
            // Icon hình vuông Stop khi DeepSeek đang sinh văn bản
            const svg = btn.querySelector('svg rect');
            if (svg && btn.getBoundingClientRect().bottom > window.innerHeight - 250) {
                return true;
            }
        }
        return false;
    }

    function checkAiThinking(adapter) {
        const thinkingEls = adapter.queryAll('[class*="thinking"], [class*="thought"]');
        for (const el of thinkingEls) {
            const txt = adapter.getText(el).toLowerCase();
            if (txt.includes('thinking...') || txt.includes('đang suy nghĩ')) {
                return true;
            }
        }
        return false;
    }

    function checkContinueButton(adapter) {
        const buttons = adapter.queryAll('div[role="button"], button');
        for (const btn of buttons) {
            if (!adapter.isVisible(btn) || btn.closest('#kagevietsub-mobile-widget')) continue;
            const txt = adapter.getText(btn).toLowerCase();
            if (txt.includes('continue') || txt.includes('tiếp tục') || txt.includes('继续')) {
                adapter.click(btn);
                return true;
            }
        }
        return false;
    }

    function getMessageElements(adapter) {
        const selectors = [
            '.ds-markdown',
            'div[class*="markdown-body"]',
            'div[class*="message-content"]'
        ];
        for (const sel of selectors) {
            const list = adapter.queryAll(sel).filter(el => !el.closest('#kagevietsub-mobile-widget'));
            if (list.length > 0) return list;
        }
        return [];
    }

    function getLatestAssistantMessage(adapter) {
        const msgs = getMessageElements(adapter);
        if (msgs.length === 0) return '';
        return adapter.getText(msgs[msgs.length - 1]);
    }

    function countAssistantMessages(adapter) {
        return getMessageElements(adapter).length;
    }

    function dispatchKeyboardEnter(adapter, composer) {
        const init = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        };
        adapter.dispatchKeyboard(composer, 'keydown', init);
        adapter.dispatchKeyboard(composer, 'keypress', init);
        return adapter.dispatchKeyboard(composer, 'keyup', init);
    }

    function evaluateSendSuccess(baselineCount, curCount, isGen, isThinking, curInputVal) {
        if (curCount > baselineCount || isGen || isThinking) return true;
        if (!curInputVal || curInputVal.trim().length === 0) return true;
        return false;
    }

    function evaluateResponseProgress(currentText, lastText, isGen, isThinking, stableCount, maxStable) {
        if (currentText && (currentText.includes('length limit') || currentText.includes('giới hạn độ dài'))) {
            return { action: 'LENGTH_LIMIT', text: currentText, stableCount: stableCount };
        }
        if (currentText && currentText !== lastText) {
            return { action: 'PROGRESS', text: currentText, stableCount: 0 };
        }
        if (isGen || isThinking || !currentText) {
            return { action: 'WAIT', text: currentText, stableCount: 0 };
        }
        const nextStable = stableCount + 1;
        if (nextStable >= maxStable) {
            return { action: 'COMPLETED', text: currentText, stableCount: nextStable };
        }
        return { action: 'WAIT', text: currentText, stableCount: nextStable };
    }

    function verifyNewChatReady(initialUrl, curUrl, initialMsgCount, curMsgCount, hasInput) {
        if (!hasInput) return false;
        if (curMsgCount === 0) return true;
        if (curUrl !== initialUrl || curMsgCount < initialMsgCount) return true;
        return false;
    }

    // =========================================================================
    // 5. QUẢN LÝ CẤU HÌNH, TỌA ĐỘ MENU & PHIÊN DỊCH (SESSION LOGIC)
    // =========================================================================

    function validateBatchSize(rawBatch) {
        const parsed = parseInt(rawBatch, 10);
        if (isNaN(parsed) || parsed < 5) return ALGORITHM_CONFIG.DEFAULT_BATCH_SIZE;
        return Math.min(1000, parsed);
    }

    function loadUserConfigLogic(rawMode, rawBatch) {
        const mode = (rawMode === 'all' || rawMode === 'lines') ? rawMode : 'lines';
        const batchSize = validateBatchSize(rawBatch);
        return { mode, batchSize };
    }

    function saveUserConfigLogic(mode, batchSize) {
        const validMode = (mode === 'all' || mode === 'lines') ? mode : 'lines';
        const validBatch = validateBatchSize(batchSize);
        return {
            mode: validMode,
            batchSize: validBatch,
            storageMode: validMode,
            storageBatch: validBatch
        };
    }

    function clampPositionLogic(left, top, elemWidth, elemHeight, winW, winH) {
        const margin = 6;
        const maxLeft = Math.max(margin, winW - (elemWidth || 350) - margin);
        const maxTop = Math.max(margin, winH - (elemHeight || 60) - margin);
        return {
            left: Math.min(maxLeft, Math.max(margin, Math.round(left))),
            top: Math.min(maxTop, Math.max(margin, Math.round(top)))
        };
    }

    function calcDragCoordsLogic(startX, startY, origLeft, origTop, clientX, clientY, elemWidth, elemHeight, winW, winH) {
        const newLeft = origLeft + (clientX - startX);
        const newTop = origTop + (clientY - startY);
        return clampPositionLogic(newLeft, newTop, elemWidth, elemHeight, winW, winH);
    }

    function parseSavedPositionLogic(rawJson) {
        if (!rawJson) return null;
        try {
            const obj = (typeof rawJson === 'string') ? JSON.parse(rawJson) : rawJson;
            if (obj && typeof obj.left === 'number' && typeof obj.top === 'number') {
                return { left: obj.left, top: obj.top };
            }
        } catch (e) {}
        return null;
    }

    function initSessionLogic(fileName, items, mode, batchSize) {
        const plan = calculateBatches(items, mode, batchSize);
        return {
            fileName: fileName || 'phu_de.srt',
            items: items || [],
            isTranslating: false,
            stopRequested: false,
            currentBatchIndex: 0,
            totalBatches: plan.totalBatches,
            lastCompletedItem: null,
            detectedEnvironment: DeviceCompatibilityManager.currentMode
        };
    }

    function serializeSessionLogic(session) {
        if (!session || !Array.isArray(session.items) || session.items.length === 0) return null;
        return JSON.stringify({
            fileName: session.fileName,
            items: session.items,
            currentBatchIndex: session.currentBatchIndex || 0,
            totalBatches: session.totalBatches || 1,
            timestamp: Date.now()
        });
    }

    function deserializeSessionLogic(rawJson, defaultBatchSize) {
        if (!rawJson) return { valid: false, session: null };
        try {
            const data = (typeof rawJson === 'string') ? JSON.parse(rawJson) : rawJson;
            if (!data || !Array.isArray(data.items) || data.items.length === 0) {
                return { valid: false, session: null };
            }
            return {
                valid: true,
                session: {
                    fileName: data.fileName || 'phu_de.srt',
                    items: data.items,
                    currentBatchIndex: data.currentBatchIndex || 0,
                    totalBatches: data.totalBatches || Math.ceil(data.items.length / (defaultBatchSize || 100))
                }
            };
        } catch (e) {
            return { valid: false, session: null };
        }
    }

    function calcSessionProgressLogic(items) {
        const total = Array.isArray(items) ? items.length : 0;
        if (total === 0) return { percent: 0, translatedCount: 0, total: 0 };
        const translatedCount = items.filter(it => it.translated && (it.status === 'completed' || it.status === 'translated')).length;
        const percent = Math.min(100, Math.round((translatedCount / total) * 100));
        return { percent, translatedCount, total };
    }

    function orchestrateBatchStep(session, batchIdx, activePrompt) {
        const plan = calculateBatches(session.items, userSettings.mode, userSettings.batchSize);
        const batch = plan.batches[batchIdx];
        const batchItems = batch ? batch.items : [];
        return {
            batchIndex: batchIdx,
            promptText: buildBatchPrompt(activePrompt, batchItems)
        };
    }

    function orchestrateRetryStep(batchItems, missingIds, activePrompt, attempt) {
        const idSet = new Set(missingIds);
        const missingItems = batchItems.filter(it => idSet.has(it.id));
        return {
            attempt: attempt,
            retryPrompt: buildRetryPrompt(missingItems)
        };
    }

    function orchestrateRecoveryStep(batchItems, activePrompt) {
        const missingItems = filterMissingItems(batchItems);
        return {
            recoveryPrompt: buildRecoveryPrompt(activePrompt, currentSession.lastCompletedItem, missingItems)
        };
    }

    function evaluatePipelineNext(session, isError, isStopped) {
        if (isStopped || (session && session.stopRequested)) {
            return { action: 'STOP', statusMessage: 'Đã dừng tiến trình dịch theo yêu cầu.' };
        }
        if (isError) {
            return { action: 'ERROR', statusMessage: 'Có lỗi xảy ra trong quá trình dịch.' };
        }
        return { action: 'NEXT_BATCH', statusMessage: 'Chuyển sang đoạn tiếp theo...' };
    }

    // =========================================================================
    // 6. CÁC HÀM ĐIỀU KHIỂN TRÌNH DUYỆT & GIAO DIỆN (GIỮ NGUYÊN TỪ FILE GỐC)
    // =========================================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    const BrowserAdapter = {
        query(sel, root = document) {
            try { return (root || document).querySelector(sel); } catch (e) { return null; }
        },
        queryAll(sel, root = document) {
            try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
        },
        closest(el, sel) {
            try { return el && el.closest ? el.closest(sel) : null; } catch (e) { return null; }
        },
        isVisible(el) {
            if (!el) return false;
            try { return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0); } catch (e) { return false; }
        },
        isDisabled(el) {
            if (!el) return true;
            try { return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'); } catch (e) { return true; }
        },
        getAttr(el, attr) {
            try { return el ? (el.getAttribute(attr) || '') : ''; } catch (e) { return ''; }
        },
        getText(el) {
            try { return el ? (el.innerText || el.textContent || '').trim() : ''; } catch (e) { return ''; }
        },
        getSvgInfo(el) {
            if (!el) return null;
            try {
                const svg = el.querySelector('.ds-button__icon svg, svg');
                if (!svg) return null;
                const pathEl = svg.querySelector('path');
                return {
                    viewBox: (svg.getAttribute('viewBox') || '').trim(),
                    width: (svg.getAttribute('width') || '').trim(),
                    height: (svg.getAttribute('height') || '').trim(),
                    pathD: (pathEl ? (pathEl.getAttribute('d') || '') : '').trim()
                };
            } catch (e) { return null; }
        },
        getInputValue(el) {
            if (!el) return '';
            try { return el.tagName && el.tagName.toLowerCase() === 'textarea' ? (el.value || '') : (el.innerText || ''); } catch (e) { return ''; }
        },
        setInputValue(el, text) {
            if (!el) return false;
            try {
                el.focus();
                if (el.tagName && el.tagName.toLowerCase() === 'textarea') {
                    const proto = Object.getPrototypeOf(el);
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (setter) {
                        setter.call(el, text);
                    } else {
                        el.value = text;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                } else {
                    el.innerText = text;
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                }
                return true;
            } catch (e) { return false; }
        },
        dispatchKeyboard(el, type, init) {
            if (!el) return false;
            try {
                el.focus();
                const evt = new KeyboardEvent(type, init);
                return el.dispatchEvent(evt);
            } catch (e) { return false; }
        },
        click(el) {
            if (!el) return false;
            try {
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                if (el.click) el.click();
                return true;
            } catch (e) {
                try { if (el.click) el.click(); return true; } catch (e2) { return false; }
            }
        },
        getTelemetry() {
            const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
            const platform = typeof navigator !== 'undefined' ? (navigator.platform || '') : '';
            const maxTouchPoints = typeof navigator !== 'undefined' ? (navigator.maxTouchPoints || 0) : 0;
            const msMaxTouchPoints = typeof navigator !== 'undefined' ? (navigator.msMaxTouchPoints || 0) : 0;
            const hasOntouchstart = typeof window !== 'undefined' ? ('ontouchstart' in window) : false;
            let isCoarse = false;
            try {
                isCoarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            } catch (e) {}
            const innerWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
            const innerHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
            const screenWidth = typeof window !== 'undefined' && window.screen ? window.screen.width : 1024;

            return {
                ua: ua.toLowerCase(),
                platform: platform.toLowerCase(),
                hasTouch: hasOntouchstart || maxTouchPoints > 0 || msMaxTouchPoints > 0,
                isCoarse: !!isCoarse,
                innerWidth: innerWidth,
                innerHeight: innerHeight,
                screenWidth: screenWidth
            };
        },
        getUrl() {
            return typeof window !== 'undefined' && window.location ? window.location.href : '';
        },
        findChatInput() {
            return findChatInputElement(this);
        },
        findSendButton(chatInput) {
            return findSendButtonElement(this, chatInput || this.findChatInput());
        },
        findNewChatButton() {
            return findNewChatButtonElement(this);
        },
        isAiGenerating() {
            return checkAiGenerating(this);
        },
        isAiThinking() {
            return checkAiThinking(this);
        },
        checkAndClickContinue() {
            return checkContinueButton(this);
        },
        getLatestAssistantText() {
            return getLatestAssistantMessage(this);
        },
        getAssistantMessageCount() {
            return countAssistantMessages(this);
        },
        sendViaKeyboardEnter(composer) {
            return dispatchKeyboardEnter(this, composer);
        }
    };

    function findChatInput() { return BrowserAdapter.findChatInput(); }
    function setInputValue(element, text) { return BrowserAdapter.setInputValue(element, text); }
    function sendViaKeyboardEnter(composer) { return BrowserAdapter.sendViaKeyboardEnter(composer); }
    function findSendButton() { return BrowserAdapter.findSendButton(); }
    function clickButton(btn) { return BrowserAdapter.click(btn); }
    function isAiGenerating() { return BrowserAdapter.isAiGenerating(); }
    function isAiThinking() { return BrowserAdapter.isAiThinking(); }
    function checkAndClickContinue() { return BrowserAdapter.checkAndClickContinue(); }
    function getLatestAssistantText() { return BrowserAdapter.getLatestAssistantText(); }
    function getAssistantMessageCount() { return BrowserAdapter.getAssistantMessageCount(); }
    function findNewChatButton() { return BrowserAdapter.findNewChatButton(); }

    async function createNewChat(maxAttempts = 3) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (currentSession.stopRequested) return false;

            let newChatBtn = null;
            const findStart = Date.now();
            while (Date.now() - findStart < 4000) {
                newChatBtn = findNewChatButton();
                if (newChatBtn) break;
                await sleep(300);
            }

            if (!newChatBtn) {
                await sleep(1000);
                continue;
            }

            const isVisible = (newChatBtn.offsetParent !== null || newChatBtn.getClientRects().length > 0);
            const isDisabled = (newChatBtn.getAttribute('aria-disabled') === 'true' || newChatBtn.hasAttribute('disabled'));

            if (!isVisible || isDisabled) {
                await sleep(1000);
                continue;
            }

            const initialUrl = window.location.href;
            const initialMsgCount = getAssistantMessageCount();

            clickButton(newChatBtn);

            const waitStart = Date.now();
            while (Date.now() - waitStart < 6000) {
                if (currentSession.stopRequested) return false;
                const curUrl = BrowserAdapter.getUrl();
                const curMsgCount = getAssistantMessageCount();
                const curInput = findChatInput();

                if (verifyNewChatReady(initialUrl, curUrl, initialMsgCount, curMsgCount, !!curInput)) {
                    break;
                }
                await sleep(400);
            }

            await sleep(500);
            const finalInput = findChatInput();
            if (finalInput) return true;
            await sleep(1000);
        }

        const errMsg = 'Không thể tạo cuộc trò chuyện mới trên DeepSeek sau 3 lần thử.';
        updateUIStatus(`Lỗi: ${errMsg}`);
        throw new Error(errMsg);
    }

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
            sendViaKeyboardEnter(input);
            await sleep(1500);
            const curVal = (input.tagName.toLowerCase() === 'textarea' ? input.value : input.innerText) || '';
            if (curVal.length > 0 && !isAiGenerating() && !isAiThinking()) {
                sendViaKeyboardEnter(input);
            }
        } else {
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

        const startConfirm = Date.now();
        while (Date.now() - startConfirm < maxWaitMs) {
            if (currentSession.stopRequested) return false;
            const curInputVal = BrowserAdapter.getInputValue(input);
            const isGen = isAiGenerating();
            const isThk = isAiThinking();
            const curCount = getAssistantMessageCount();

            if (evaluateSendSuccess(baselineCount, curCount, isGen, isThk, curInputVal)) {
                return true;
            }
            await sleep(300);
        }

        return false;
    }

    class ResponseMonitor {
        constructor(options = {}) {
            this.onProgress = options.onProgress || null;
            this.timeoutSec = options.timeoutSec || 300;
            this.state = 'UNINITIALIZED';
            this.observer = null;
            this.observedContainer = null;
            this.baselineMsgCount = 0;
            this.firstMutationDetected = false;
            this.lastReportedText = '';
            this.stableCount = 0;
            this.resolvePromise = null;
            this.rejectPromise = null;
            this.completionPromise = null;
            this.startTime = 0;
        }

        async init() {
            this.state = 'INITIALIZING';
            this.cleanup();
            const container = this.findResponseContainer();
            this.observedContainer = container || ((typeof document !== 'undefined') ? document.body : null);
            this.baselineMsgCount = getAssistantMessageCount();
            this.createObserver();
            this.state = 'READY';
            return true;
        }

        findResponseContainer() {
            const selectors = [
                'div[class*="chat-scroll"]',
                'div[class*="chat-container"]',
                'div[class*="chat-main"]',
                'div[class*="message-list"]',
                'main',
                '#root'
            ];
            for (let i = 0; i < selectors.length; i++) {
                const el = BrowserAdapter.query(selectors[i]);
                if (el && BrowserAdapter.isVisible(el)) return el;
            }
            return (typeof document !== 'undefined') ? document.body : null;
        }

        createObserver() {
            if (typeof MutationObserver === 'undefined') return;
            this.observer = new MutationObserver(() => {
                if (this.state !== 'MONITORING' && this.state !== 'READY') return;
                if (!this.firstMutationDetected) this.firstMutationDetected = true;
                this.checkAndReportUpdate();
            });

            const target = this.observedContainer || ((typeof document !== 'undefined') ? document.body : null);
            if (target && target.nodeType) {
                try {
                    this.observer.observe(target, { childList: true, subtree: true, characterData: true });
                } catch (e) {}
            }
        }

        startMonitoring() {
            if (this.state === 'UNINITIALIZED' || !this.observer) this.init();
            this.state = 'MONITORING';
            this.startTime = Date.now();
            this.firstMutationDetected = false;
            this.lastReportedText = '';
            this.stableCount = 0;

            this.completionPromise = new Promise((resolve, reject) => {
                this.resolvePromise = resolve;
                this.rejectPromise = reject;
            });

            this.startPollLoop();
            return this.completionPromise;
        }

        checkAndReportUpdate() {
            if (this.state !== 'MONITORING') return;
            const currentText = getLatestAssistantText();
            if (!currentText) return;

            if (currentText !== this.lastReportedText) {
                this.lastReportedText = currentText;
                this.stableCount = 0;
                if (this.onProgress) {
                    try { this.onProgress(currentText); } catch (e) {}
                }
            }
        }

        async startPollLoop() {
            while (this.state === 'MONITORING') {
                if (Date.now() - this.startTime > this.timeoutSec * 1000) {
                    this.finish(this.lastReportedText);
                    return;
                }
                if (currentSession && currentSession.stopRequested) {
                    this.finish(this.lastReportedText);
                    return;
                }
                if (checkAndClickContinue()) {
                    this.stableCount = 0;
                    await sleep(1000);
                    continue;
                }

                this.ensureContainerAttached();

                const isGen = isAiGenerating();
                const isThk = isAiThinking();
                const currentText = getLatestAssistantText();

                const evalState = evaluateResponseProgress(
                    currentText,
                    this.lastReportedText,
                    isGen,
                    isThk,
                    this.stableCount,
                    CONFIG.STABLE_CHECKS_REQUIRED
                );

                if (evalState.action === 'LENGTH_LIMIT') {
                    this.state = 'ERROR';
                    this.cleanup();
                    if (this.rejectPromise) this.rejectPromise(new Error('DEEPSEEK_LENGTH_LIMIT'));
                    return;
                } else if (evalState.action === 'PROGRESS') {
                    this.lastReportedText = evalState.text;
                    this.stableCount = 0;
                    if (this.onProgress) {
                        try { this.onProgress(this.lastReportedText); } catch (e) {}
                    }
                } else if (evalState.action === 'COMPLETED') {
                    this.finish(evalState.text || this.lastReportedText);
                    return;
                } else {
                    this.stableCount = evalState.stableCount;
                }

                await sleep(CONFIG.POLL_INTERVAL_MS);
            }
        }

        ensureContainerAttached() {
            if (typeof document === 'undefined') return;
            if (!this.observedContainer || !document.contains(this.observedContainer)) {
                this.observedContainer = this.findResponseContainer();
                if (this.observer) {
                    try {
                        this.observer.disconnect();
                        this.observer.observe(this.observedContainer || document.body, {
                            childList: true,
                            subtree: true,
                            characterData: true
                        });
                    } catch (e) {}
                }
            }
        }

        finish(resultText) {
            if (this.state === 'COMPLETED') return;
            this.state = 'COMPLETED';
            this.cleanup();
            if (this.resolvePromise) this.resolvePromise(resultText || this.lastReportedText);
        }

        abort() {
            this.state = 'ABORTED';
            this.cleanup();
            if (this.resolvePromise) this.resolvePromise(this.lastReportedText);
        }

        cleanup() {
            if (this.observer && this.observer.disconnect) {
                try { this.observer.disconnect(); } catch (e) {}
            }
            this.observer = null;
        }
    }

    async function recoverDeepSeekLengthLimit(batchItems, activePrompt) {
        updateUIStatus('Phát hiện DeepSeek Length Limit! Đang tạo chat mới và nạp ngữ cảnh...');

        for (let attempt = 1; attempt <= 3; attempt++) {
            if (currentSession.stopRequested) return false;
            const missingItemsList = filterMissingItems(batchItems);
            if (missingItemsList.length === 0) {
                updateUIStatus('Khôi phục thành công! Đã dịch đủ các câu.');
                return true;
            }

            updateUIStatus(`Khôi phục lần ${attempt}/3: Mở chat mới cho ${missingItemsList.length} câu còn thiếu...`);
            const newChatOk = await createNewChat();
            if (!newChatOk) {
                await sleep(1500);
                continue;
            }
            await sleep(1500);

            const recStep = orchestrateRecoveryStep(batchItems, activePrompt);
            const recoveryMessage = (recStep && recStep.recoveryPrompt)
                ? recStep.recoveryPrompt
                : buildRecoveryPrompt(activePrompt, currentSession.lastCompletedItem, missingItemsList);

            const monitor = new ResponseMonitor({ timeoutSec: 300 });
            await monitor.init();

            const sent = await sendMessageAndWaitConfirmation(recoveryMessage);
            if (!sent) {
                monitor.abort();
                await sleep(1000);
                continue;
            }

            const resp = await monitor.startMonitoring();
            const missingSet = new Set(missingItemsList.map(it => it.id));
            const parsed = parseAiResponse(resp, missingSet);

            applyRecoveryResults(batchItems, parsed, currentSession.lastCompletedItem ? currentSession.lastCompletedItem.id : null);
            updateSessionProgress();
        }

        return filterMissingItems(batchItems).length === 0;
    }

    async function processBatchWithRetries(batchItems, activePrompt, batchIdx, totalBatches) {
        updateUIStatus(`Đang dịch đoạn ${batchIdx}/${totalBatches}...`);

        const batchStep = orchestrateBatchStep(currentSession, batchIdx - 1, activePrompt);
        const initialPrompt = (batchStep && batchStep.promptText) ? batchStep.promptText : buildBatchPrompt(activePrompt, batchItems);

        const monitor = new ResponseMonitor({
            onProgress: (text) => {
                const partial = parseAiResponse(text, batchItems);
                validateTranslationResults(batchItems, partial);
                updateSessionProgress();
            },
            timeoutSec: 300
        });
        await monitor.init();

        const sent = await sendMessageAndWaitConfirmation(initialPrompt);
        if (!sent) {
            monitor.abort();
            throw new Error(`Không thể gửi đoạn ${batchIdx} vào DeepSeek.`);
        }

        updateUIStatus(`Đang chờ DeepSeek trả lời đoạn ${batchIdx}/${totalBatches}...`);

        let responseText = '';
        try {
            responseText = await monitor.startMonitoring();
        } catch (err) {
            if (err.message === 'DEEPSEEK_LENGTH_LIMIT') {
                const recovered = await recoverDeepSeekLengthLimit(batchItems, activePrompt);
                if (!recovered) {
                    throw new Error(`Đoạn ${batchIdx} bị ngắt bởi Length Limit và không thể phục hồi.`);
                }
                saveSessionToStorage();
                return true;
            }
            throw err;
        }

        const parsedResults = parseAiResponse(responseText, batchItems);
        validateTranslationResults(batchItems, parsedResults);

        let retryAttempt = 1;
        while (retryAttempt <= CONFIG.MAX_RETRIES && !currentSession.stopRequested) {
            const progress = evaluateBatchProgress(batchItems, CONFIG.MAX_RETRIES, retryAttempt);
            if (progress.isComplete) break;

            updateUIStatus(progress.statusMessage);
            await sleep(1500);

            const missingItems = filterMissingItems(batchItems);
            const missingIds = missingItems.map(it => it.id);
            const retryStep = orchestrateRetryStep(batchItems, missingIds, activePrompt, retryAttempt);
            const retryMessage = (retryStep && retryStep.retryPrompt) ? retryStep.retryPrompt : buildRetryPrompt(missingItems);

            const retryMonitor = new ResponseMonitor({ timeoutSec: 300 });
            await retryMonitor.init();

            const retrySent = await sendMessageAndWaitConfirmation(retryMessage);
            if (!retrySent) {
                retryMonitor.abort();
                retryAttempt++;
                continue;
            }

            let retryResponse = '';
            try {
                retryResponse = await retryMonitor.startMonitoring();
            } catch (err) {
                if (err.message === 'DEEPSEEK_LENGTH_LIMIT') {
                    await recoverDeepSeekLengthLimit(batchItems, activePrompt);
                    break;
                }
                throw err;
            }

            const retryParsed = parseAiResponse(retryResponse, missingItems);
            validateTranslationResults(missingItems, retryParsed);
            updateSessionProgress();
            retryAttempt++;
        }

        const finalProgress = evaluateBatchProgress(batchItems, CONFIG.MAX_RETRIES, retryAttempt);
        if (!finalProgress.isComplete) {
            throw new Error(`Đoạn ${batchIdx} còn thiếu ${finalProgress.missingCount} câu sau ${CONFIG.MAX_RETRIES} lần thử lại.`);
        }

        saveSessionToStorage();
        return true;
    }

    async function startTranslationProcess() {
        if (!currentSession.items || currentSession.items.length === 0) {
            alert('Vui lòng chọn file phụ đề SRT trước.');
            return;
        }

        initBatchState(currentSession.items);
        DeviceCompatibilityManager.detect();

        const customPromptText = (uiElements.customPromptInput ? uiElements.customPromptInput.value : '').trim();
        const activePrompt = customPromptText || getDefaultPrompt();

        const totalItems = currentSession.items.length;
        const mode = userSettings.mode;

        if (mode === 'all') {
            const totalChars = currentSession.items.reduce((sum, it) => sum + it.original.length, 0);
            if (totalItems > CONFIG.SAFE_FULL_MODE_ITEMS || totalChars > CONFIG.SAFE_FULL_MODE_CHARS) {
                const confirmMsg = `CẢNH BÁO: File có ${totalItems.toLocaleString('vi-VN')} dòng phụ đề (~${totalChars.toLocaleString('vi-VN')} ký tự).\n\n` +
                    `Gửi toàn bộ trong 1 lần vượt ngưỡng tối ưu của DeepSeek, dễ dẫn đến bị ngắt câu.\n\n` +
                    `Bạn có muốn tiếp tục gửi toàn bộ không?`;
                if (!confirm(confirmMsg)) {
                    updateUIStatus('Đã hủy gửi toàn bộ. Vui lòng chọn chế độ chia đoạn.');
                    return;
                }
            }
        }

        currentSession.isTranslating = true;
        currentSession.stopRequested = false;
        updateUIState(true);

        const batchPlan = calculateBatches(currentSession.items, userSettings.mode, userSettings.batchSize);
        const totalBatches = batchPlan.totalBatches;
        currentSession.totalBatches = totalBatches;

        try {
            updateUIStatus('Đang kiểm tra giao diện DeepSeek...');

            if (DeviceCompatibilityManager.isMobile() && currentSession.currentBatchIndex === 0) {
                const initialMsgCount = getAssistantMessageCount();
                if (initialMsgCount > 0) {
                    updateUIStatus('Đang tạo cuộc trò chuyện mới trên điện thoại...');
                    await createNewChat();
                    await sleep(1500);
                }
            }

            const input = findChatInput();
            if (!input) {
                throw new Error('Không tìm thấy khung nhập tin nhắn của DeepSeek. Vui lòng kiểm tra đã đăng nhập chưa.');
            }

            for (let b = currentSession.currentBatchIndex; b < totalBatches; b++) {
                if (currentSession.stopRequested) {
                    const pipeStop = evaluatePipelineNext(currentSession, false, true);
                    updateUIStatus(pipeStop.statusMessage);
                    break;
                }

                currentSession.currentBatchIndex = b;
                const batchItems = batchPlan.batches[b].items;

                await processBatchWithRetries(batchItems, activePrompt, b + 1, totalBatches);

                const pipeNext = evaluatePipelineNext(currentSession, false, currentSession.stopRequested);
                if (pipeNext && pipeNext.action === 'NEXT_BATCH') {
                    if (b + 1 < totalBatches && !currentSession.stopRequested) {
                        updateUIStatus(`Đang tạo cuộc trò chuyện mới cho đoạn ${b + 2}/${totalBatches}...`);
                        await createNewChat();
                        await sleep(2000);
                    }
                }
            }

            const missingTotal = currentSession.items.filter(it => it.status !== 'completed');
            if (missingTotal.length === 0 && !currentSession.stopRequested) {
                updateUIStatus('Đang xác thực và tạo file phụ đề hoàn chỉnh...');
                await sleep(500);
                downloadTranslatedSrt();
                updateUIStatus('Hoàn thành! Đã tự động tải file SRT.');
                clearSessionStorage();
            } else if (!currentSession.stopRequested) {
                updateUIStatus(`Dịch chưa xong: Còn thiếu ${missingTotal.length} câu.`);
                alert(`Không thể xuất file: Còn ${missingTotal.length} câu chưa hoàn thành dịch.`);
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

    function downloadTranslatedSrt() {
        const validation = validateFinalExport(currentSession.items);
        if (!validation.valid) {
            alert(`Lỗi kiểm tra tính toàn vẹn phụ đề: ${validation.reason}`);
            return;
        }

        const srtContent = buildCompleteSrtContent(currentSession.items);
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

    function downloadSamplePrompt() {
        const sampleText = getSamplePromptText();
        const blob = new Blob([sampleText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'KAGEVIETSUB_PROMPT_MAU.txt';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 2000);
    }

    function saveSessionToStorage() {
        const serialized = serializeSessionLogic(currentSession);
        if (serialized) StorageAdapter.set(CONFIG.STORAGE_KEY, serialized);
    }

    function loadSessionFromStorage() {
        const raw = StorageAdapter.get(CONFIG.STORAGE_KEY, null);
        const res = deserializeSessionLogic(raw, userSettings.batchSize);
        return (res && res.valid) ? res.session : null;
    }

    function clearSessionStorage() {
        StorageAdapter.remove(CONFIG.STORAGE_KEY);
    }

    let uiElements = {};

    const PositionManager = {
        STORAGE_KEY: 'kg_pref_widget_position',
        clamp(left, top, elemWidth, elemHeight) {
            const winW = window.innerWidth || document.documentElement.clientWidth || 390;
            const winH = window.innerHeight || document.documentElement.clientHeight || 844;
            return clampPositionLogic(left, top, elemWidth, elemHeight, winW, winH);
        },
        save(left, top) {
            try { StorageAdapter.set(this.STORAGE_KEY, { left, top, timestamp: Date.now() }); } catch (e) {}
        },
        load() {
            return parseSavedPositionLogic(StorageAdapter.get(this.STORAGE_KEY, null));
        },
        applySaved(container) {
            const pos = this.load();
            if (pos && container) {
                const rect = container.getBoundingClientRect();
                const clamped = this.clamp(pos.left, pos.top, rect.width || 350, rect.height || 120);
                container.style.left = `${clamped.left}px`;
                container.style.top = `${clamped.top}px`;
                container.style.right = 'auto';
                container.style.bottom = 'auto';
                return true;
            }
            return false;
        },
        attachDrag(headerEl, containerEl) {
            if (!headerEl || !containerEl) return;
            headerEl.style.cursor = 'grab';
            headerEl.style.touchAction = 'none';

            let isDragging = false, startPointerX = 0, startPointerY = 0, startLeft = 0, startTop = 0, hasMoved = false;

            headerEl.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (e.target.closest('button, #kg-collapse-btn, input, select')) return;

                const rect = containerEl.getBoundingClientRect();
                isDragging = true;
                hasMoved = false;
                startPointerX = e.clientX;
                startPointerY = e.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                headerEl.style.cursor = 'grabbing';
                try { headerEl.setPointerCapture(e.pointerId); } catch (err) {}
                e.preventDefault();
            });

            headerEl.addEventListener('pointermove', (e) => {
                if (!isDragging) return;
                if (Math.abs(e.clientX - startPointerX) > 3 || Math.abs(e.clientY - startPointerY) > 3) {
                    hasMoved = true;
                }
                if (hasMoved) {
                    const rect = containerEl.getBoundingClientRect();
                    const winW = window.innerWidth || document.documentElement.clientWidth || 390;
                    const winH = window.innerHeight || document.documentElement.clientHeight || 844;
                    const clamped = calcDragCoordsLogic(startPointerX, startPointerY, startLeft, startTop, e.clientX, e.clientY, rect.width, rect.height, winW, winH);
                    containerEl.style.left = `${clamped.left}px`;
                    containerEl.style.top = `${clamped.top}px`;
                    containerEl.style.right = 'auto';
                    containerEl.style.bottom = 'auto';
                }
            });

            const stopDrag = (e) => {
                if (!isDragging) return;
                isDragging = false;
                headerEl.style.cursor = 'grab';
                try {
                    if (headerEl.hasPointerCapture(e.pointerId)) headerEl.releasePointerCapture(e.pointerId);
                } catch (err) {}
                if (hasMoved) {
                    const rect = containerEl.getBoundingClientRect();
                    const clamped = PositionManager.clamp(rect.left, rect.top, rect.width, rect.height);
                    PositionManager.save(clamped.left, clamped.top);
                }
            };

            headerEl.addEventListener('pointerup', stopDrag);
            headerEl.addEventListener('pointercancel', stopDrag);
        }
    };

    function injectUI() {
        if (document.getElementById('kagevietsub-mobile-widget')) return;
        loadUserConfig();

        if (!document.getElementById('kg-widget-styles')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'kg-widget-styles';
            styleEl.textContent = `
                .kg-panel { position: fixed; top: 12px; right: 12px; width: calc(100vw - 24px); max-width: 360px; background: #111318; color: #F1F4F9; border: 1px solid #2A3241; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.7); z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; box-sizing: border-box; user-select: none; overflow: hidden; }
                .kg-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #191D25; border-bottom: 1px solid #2A3241; cursor: grab; touch-action: none; }
                .kg-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: #F1F4F9; }
                .kg-badge-sub { font-size: 10px; font-weight: 700; background: rgba(77,141,255,0.15); color: #4D8DFF; border: 1px solid rgba(77,141,255,0.3); padding: 2px 6px; border-radius: 4px; }
                .kg-icon-btn { width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #9AA4B2; cursor: pointer; }
                .kg-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 80px); overflow-y: auto; background: #111318; }
                .kg-card { background: #191D25; border: 1px solid #2A3241; border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }
                .kg-file-btn { background: #202631; color: #F1F4F9; border: 1px dashed #4D8DFF; border-radius: 8px; padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 42px; }
                .kg-file-meta { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #9AA4B2; }
                .kg-file-meta-val { color: #F1F4F9; font-weight: 500; }
                .kg-label { font-size: 11px; font-weight: 600; color: #9AA4B2; text-transform: uppercase; }
                .kg-select, .kg-input { background: #202631; color: #F1F4F9; border: 1px solid #2A3241; border-radius: 7px; padding: 8px 10px; font-size: 13px; outline: none; width: 100%; box-sizing: border-box; }
                .kg-accordion { background: #191D25; border: 1px solid #2A3241; border-radius: 9px; overflow: hidden; }
                .kg-accordion-header { padding: 9px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12px; font-weight: 600; }
                .kg-badge-default { font-size: 10px; color: #20B982; background: rgba(32,185,130,0.12); border: 1px solid rgba(32,185,130,0.3); padding: 2px 7px; border-radius: 4px; }
                .kg-badge-custom { font-size: 10px; color: #4D8DFF; background: rgba(77,141,255,0.12); border: 1px solid rgba(77,141,255,0.3); padding: 2px 7px; border-radius: 4px; }
                .kg-accordion-body { display: none; padding: 10px 12px; flex-direction: column; gap: 8px; border-top: 1px solid #2A3241; background: #15181F; }
                .kg-textarea { width: 100%; min-height: 80px; background: #202631; color: #F1F4F9; border: 1px solid #2A3241; border-radius: 7px; padding: 8px 10px; font-size: 11px; resize: vertical; box-sizing: border-box; }
                .kg-sub-btn { background: #202631; color: #4D8DFF; border: 1px solid rgba(77,141,255,0.4); border-radius: 6px; padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
                .kg-primary-btn { background: #4D8DFF; color: #FFF; border: none; border-radius: 8px; padding: 12px 16px; font-size: 14px; font-weight: 700; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; }
                .kg-primary-btn:disabled { opacity: 0.45; cursor: not-allowed; }
                .kg-stop-btn { background: #E45B65 !important; }
                .kg-progress-track { width: 100%; height: 7px; background: #202631; border-radius: 4px; overflow: hidden; }
                .kg-progress-fill { width: 0%; height: 100%; background: #4D8DFF; transition: width 0.3s ease; }
                .kg-status-box { font-size: 12px; color: #9AA4B2; min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .kg-resume-card { display: none; background: #191D25; border: 1px solid #4D8DFF; border-radius: 8px; padding: 10px; flex-direction: column; gap: 8px; }
            `;
            document.head.appendChild(styleEl);
        }

        const container = document.createElement('div');
        container.id = 'kagevietsub-mobile-widget';
        container.className = 'kg-panel';
        container.innerHTML = `
            <div id="kg-header" class="kg-header">
                <div class="kg-brand">
                    <span>KAGEVIETSUB</span>
                    <span class="kg-badge-sub">TRANSLATOR</span>
                </div>
                <button id="kg-collapse-btn" class="kg-icon-btn" title="Thu gọn/Mở rộng">−</button>
            </div>
            <div id="kg-body" class="kg-body">
                <input type="file" id="kg-file-input" accept=".srt" style="display: none;" />
                <div class="kg-card">
                    <button id="kg-select-file-btn" class="kg-file-btn">[ Chọn file SRT ]</button>
                    <div class="kg-file-meta">
                        <div id="kg-filename-label">Tên file: <span class="kg-file-meta-val">(Chưa chọn)</span></div>
                        <div id="kg-total-count-label">Tổng phụ đề: <span class="kg-file-meta-val">0 dòng</span></div>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <label class="kg-label">Chế độ gửi:</label>
                    <select id="kg-mode-select" class="kg-select">
                        <option value="lines">Gửi theo số dòng ▼</option>
                        <option value="all">Gửi toàn bộ SRT</option>
                    </select>
                </div>
                <div id="kg-batch-container" style="display: flex; flex-direction: column; gap: 4px;">
                    <label class="kg-label">Số dòng mỗi lần:</label>
                    <div style="display: flex; gap: 6px;">
                        <select id="kg-batch-select" class="kg-select" style="flex: 1;">
                            <option value="20">20 dòng</option>
                            <option value="50">50 dòng</option>
                            <option value="100">100 dòng</option>
                            <option value="200">200 dòng</option>
                            <option value="300">300 dòng</option>
                            <option value="custom">Tùy chỉnh...</option>
                        </select>
                        <input type="number" id="kg-batch-custom-input" class="kg-input" min="5" max="1000" placeholder="Số dòng" style="display: none; width: 90px;" />
                    </div>
                </div>
                <div class="kg-accordion">
                    <div id="kg-prompt-header" class="kg-accordion-header">
                        <span>PROMPT AI</span>
                        <div>
                            <span id="kg-prompt-badge" class="kg-badge-default">[ Mặc định ]</span>
                            <span id="kg-prompt-toggle-btn" style="color: #4D8DFF; font-weight: bold; margin-left: 6px;">+</span>
                        </div>
                    </div>
                    <div id="kg-prompt-body" class="kg-accordion-body">
                        <textarea id="kg-custom-prompt-input" class="kg-textarea" placeholder="Để trống để dùng Prompt mặc định..."></textarea>
                        <div style="display: flex; gap: 6px;">
                            <button id="kg-download-sample-prompt-btn" type="button" class="kg-sub-btn" style="flex: 1;">Tải Prompt mẫu</button>
                            <button id="kg-clear-prompt-btn" type="button" class="kg-sub-btn">Xóa</button>
                        </div>
                    </div>
                </div>
                <button id="kg-start-btn" class="kg-primary-btn" disabled>BẮT ĐẦU DỊCH</button>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span id="kg-progress-label" style="font-weight: 600; font-size: 12px;">Tiến trình: 0%</span>
                    <span id="kg-count-label" style="color: #9AA4B2; font-size: 11px;">0/0 câu</span>
                </div>
                <div class="kg-progress-track"><div id="kg-progress-bar" class="kg-progress-fill"></div></div>
                <div id="kg-status-label" class="kg-status-box">Đang chờ bắt đầu...</div>
                <div id="kg-resume-banner" class="kg-resume-card">
                    <span style="color: #4D8DFF; font-weight: 600; font-size: 12px;">Tìm thấy phiên dịch dở dang!</span>
                    <div style="display: flex; gap: 6px;">
                        <button id="kg-resume-btn" style="flex: 1; background: #20B982; color: white; border: none; border-radius: 6px; padding: 7px; font-weight: 600; cursor: pointer;">Tiếp tục</button>
                        <button id="kg-discard-btn" style="flex: 1; background: #E45B65; color: white; border: none; border-radius: 6px; padding: 7px; font-weight: 600; cursor: pointer;">Hủy bỏ</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        uiElements = {
            container,
            header: container.querySelector('#kg-header'),
            fileInput: container.querySelector('#kg-file-input'),
            selectFileBtn: container.querySelector('#kg-select-file-btn'),
            fileNameLabel: container.querySelector('#kg-filename-label'),
            totalCountLabel: container.querySelector('#kg-total-count-label'),
            modeSelect: container.querySelector('#kg-mode-select'),
            batchSizeContainer: container.querySelector('#kg-batch-container'),
            batchSelect: container.querySelector('#kg-batch-select'),
            batchCustomInput: container.querySelector('#kg-batch-custom-input'),
            promptToggleBtn: container.querySelector('#kg-prompt-toggle-btn'),
            promptBody: container.querySelector('#kg-prompt-body'),
            promptBadge: container.querySelector('#kg-prompt-badge'),
            customPromptInput: container.querySelector('#kg-custom-prompt-input'),
            downloadSamplePromptBtn: container.querySelector('#kg-download-sample-prompt-btn'),
            clearPromptBtn: container.querySelector('#kg-clear-prompt-btn'),
            startBtn: container.querySelector('#kg-start-btn'),
            progressLabel: container.querySelector('#kg-progress-label'),
            progressBar: container.querySelector('#kg-progress-bar'),
            statusLabel: container.querySelector('#kg-status-label'),
            collapseBtn: container.querySelector('#kg-collapse-btn'),
            contentBody: container.querySelector('#kg-body'),
            countLabel: container.querySelector('#kg-count-label')
        };

        syncConfigToUI();

        let isPromptExpanded = false;
        container.querySelector('#kg-prompt-header').addEventListener('click', () => {
            isPromptExpanded = !isPromptExpanded;
            uiElements.promptBody.style.display = isPromptExpanded ? 'flex' : 'none';
            uiElements.promptToggleBtn.innerText = isPromptExpanded ? '−' : '+';
        });

        const updatePromptBadge = () => {
            const val = (uiElements.customPromptInput.value || '').trim();
            uiElements.promptBadge.innerText = val ? '[ Tùy chỉnh ]' : '[ Mặc định ]';
            uiElements.promptBadge.className = val ? 'kg-badge-custom' : 'kg-badge-default';
        };

        uiElements.customPromptInput.addEventListener('input', updatePromptBadge);
        uiElements.clearPromptBtn.addEventListener('click', () => {
            uiElements.customPromptInput.value = '';
            updatePromptBadge();
        });
        uiElements.downloadSamplePromptBtn.addEventListener('click', downloadSamplePrompt);

        uiElements.modeSelect.addEventListener('change', () => {
            userSettings.mode = uiElements.modeSelect.value;
            uiElements.batchSizeContainer.style.display = (userSettings.mode === 'all') ? 'none' : 'flex';
            saveUserConfig(userSettings.mode, userSettings.batchSize);
        });

        uiElements.batchSelect.addEventListener('change', () => {
            const val = uiElements.batchSelect.value;
            if (val === 'custom') {
                uiElements.batchCustomInput.style.display = 'block';
                uiElements.batchCustomInput.value = userSettings.batchSize;
            } else {
                uiElements.batchCustomInput.style.display = 'none';
                userSettings.batchSize = Number(val);
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        });

        uiElements.batchCustomInput.addEventListener('change', () => {
            const val = parseInt(uiElements.batchCustomInput.value, 10);
            if (!isNaN(val) && val >= 5) {
                userSettings.batchSize = val;
                saveUserConfig(userSettings.mode, userSettings.batchSize);
            }
        });

        uiElements.selectFileBtn.addEventListener('click', () => {
            if (!currentSession.isTranslating) uiElements.fileInput.click();
        });

        uiElements.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                const items = parseSrtContent(evt.target.result);
                if (items.length === 0) {
                    alert('File SRT không hợp lệ.');
                    return;
                }
                currentSession.fileName = file.name;
                currentSession.items = items;
                currentSession.currentBatchIndex = 0;
                uiElements.fileNameLabel.innerHTML = `Tên file: <span class="kg-file-meta-val">${file.name}</span>`;
                uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span class="kg-file-meta-val">${items.length.toLocaleString('vi-VN')} dòng</span>`;
                uiElements.startBtn.disabled = false;
                updateSessionProgress();
                updateUIStatus('Đã đọc file xong. Nhấn [ BẮT ĐẦU DỊCH ].');
            };
            reader.readAsText(file, 'utf-8');
        });

        uiElements.startBtn.addEventListener('click', () => {
            if (currentSession.isTranslating) {
                if (confirm('Bạn có chắc muốn dừng tiến trình dịch?')) {
                    currentSession.stopRequested = true;
                    updateUIStatus('Đang gửi lệnh dừng...');
                }
                return;
            }
            startTranslationProcess();
        });

        let isCollapsed = false;
        uiElements.collapseBtn.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            uiElements.contentBody.style.display = isCollapsed ? 'none' : 'flex';
            uiElements.collapseBtn.innerText = isCollapsed ? '+' : '−';
            container.style.width = isCollapsed ? 'auto' : 'calc(100vw - 24px)';
        });

        PositionManager.attachDrag(uiElements.header, container);
        PositionManager.applySaved(container);
        checkSavedSession();
    }

    function syncConfigToUI() {
        uiElements.modeSelect.value = userSettings.mode;
        uiElements.batchSizeContainer.style.display = (userSettings.mode === 'all') ? 'none' : 'flex';
        const validPresets = ['20', '50', '100', '200', '300'];
        if (validPresets.includes(String(userSettings.batchSize))) {
            uiElements.batchSelect.value = String(userSettings.batchSize);
            uiElements.batchCustomInput.style.display = 'none';
        } else {
            uiElements.batchSelect.value = 'custom';
            uiElements.batchCustomInput.style.display = 'block';
            uiElements.batchCustomInput.value = userSettings.batchSize;
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
        const prog = calcSessionProgressLogic(currentSession.items);
        if (uiElements.progressLabel) uiElements.progressLabel.innerText = `Tiến trình: ${prog.percent}%`;
        if (uiElements.countLabel) uiElements.countLabel.innerText = `${prog.translatedCount}/${prog.total} câu`;
        if (uiElements.progressBar) uiElements.progressBar.style.width = `${prog.percent}%`;
    }

    function updateUIState(isTranslating) {
        if (!uiElements.startBtn) return;
        if (isTranslating) {
            uiElements.startBtn.className = 'kg-primary-btn kg-stop-btn';
            uiElements.startBtn.innerText = 'DỪNG DỊCH';
            uiElements.selectFileBtn.style.pointerEvents = 'none';
            uiElements.selectFileBtn.style.opacity = '0.5';
            uiElements.modeSelect.disabled = true;
            uiElements.batchSelect.disabled = true;
        } else {
            uiElements.startBtn.className = 'kg-primary-btn';
            uiElements.startBtn.innerText = 'BẮT ĐẦU DỊCH';
            uiElements.selectFileBtn.style.pointerEvents = 'auto';
            uiElements.selectFileBtn.style.opacity = '1';
            uiElements.modeSelect.disabled = false;
            uiElements.batchSelect.disabled = false;
        }
    }

    function checkSavedSession() {
        const saved = loadSessionFromStorage();
        if (saved && saved.items && saved.items.length > 0) {
            const translatedCount = saved.items.filter(it => it.translated && (it.status === 'completed' || it.status === 'translated')).length;
            if (translatedCount > 0 && translatedCount < saved.items.length) {
                const banner = document.getElementById('kg-resume-banner');
                if (banner) {
                    banner.style.display = 'flex';
                    document.getElementById('kg-resume-btn').onclick = () => {
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
                        uiElements.fileNameLabel.innerHTML = `Tên file: <span class="kg-file-meta-val">${saved.fileName}</span>`;
                        uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span class="kg-file-meta-val">${saved.items.length.toLocaleString('vi-VN')} dòng</span>`;
                        uiElements.startBtn.disabled = false;
                        updateSessionProgress();
                        updateUIStatus(`Đã khôi phục ${translatedCount}/${saved.items.length} câu. Nhấn [ BẮT ĐẦU DỊCH ] để tiếp tục.`);
                    };
                    document.getElementById('kg-discard-btn').onclick = () => {
                        clearSessionStorage();
                        banner.style.display = 'none';
                        updateUIStatus('Đã hủy phiên dịch cũ.');
                    };
                }
            }
        }
    }

    window.addEventListener('load', () => setTimeout(injectUI, 1200));
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectUI, 1000);
    }
})();
