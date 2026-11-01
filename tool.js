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

    const CONFIG = {
        DEFAULT_BATCH_SIZE: 100,       
        MAX_RETRIES: 3,                
        POLL_INTERVAL_MS: 800,         
        STABLE_CHECKS_REQUIRED: 3,     
        SAFE_FULL_MODE_ITEMS: 300,     
        SAFE_FULL_MODE_CHARS: 25000,   
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

    const CHINESE_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

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

    const DeviceCompatibilityManager = {
        MODE_DESKTOP: 'DESKTOP',
        MODE_MOBILE: 'MOBILE',
        currentMode: null,

        detect() {
            const ua = (navigator.userAgent || '').toLowerCase();
            const platform = (navigator.platform || '').toLowerCase();

            const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);

            let isCoarse = false;
            try {
                isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            } catch (e) {}

            const isMobileUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
            const isIpadOs = platform.includes('mac') && hasTouch && navigator.maxTouchPoints > 1;
            const isSmallScreen = window.innerWidth <= 768 || window.screen.width <= 768;

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

    function normalizeTimeline(timelineStr) {
        if (!timelineStr) return '';
        return timelineStr.replace(/,/g, '.').replace(/\s*-->\s*/g, ' --> ').trim();
    }

    function parseSrtContent(content) {
        if (!content) return [];
        
        const cleaned = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const blocks = cleaned.trim().split(/\n\s*\n/);
        const items = [];
        let autoId = 1;

        for (let i = 0; i < blocks.length; i++) {
            const lines = blocks[i].split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length < 2) continue;

            let timeIdx = -1;
            for (let j = 0; j < lines.length; j++) {
                if (lines[j].includes('-->')) {
                    timeIdx = j;
                    break;
                }
            }

            if (timeIdx === -1) continue;

            let originalIndex = autoId;
            if (timeIdx > 0) {
                const parsedIndex = parseInt(lines[0], 10);
                if (!isNaN(parsedIndex)) {
                    originalIndex = parsedIndex;
                }
            }

            const timeline = lines[timeIdx];
            const parts = timeline.split('-->');
            const startTime = parts[0] ? parts[0].trim() : '';
            const endTime = parts[1] ? parts[1].trim() : '';
            const normTimeline = normalizeTimeline(timeline);

            const textLines = lines.slice(timeIdx + 1);
            const originalText = textLines.join(' ').trim();
            if (!originalText) continue;

            items.push({
                id: autoId,                      
                originalIndex: originalIndex,    
                timeline: timeline,              
                normalizedTimeline: normTimeline, 
                startTime: startTime,
                endTime: endTime,
                original: originalText,
                translated: null,
                status: 'pending',               
                errorReason: null
            });
            autoId++;
        }

        return items;
    }

    function cleanMarkdown(raw) {
        if (!raw) return '';
        let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        cleaned = cleaned.replace(/--&gt;/g, '-->').replace(/-&gt;/g, '->').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
        cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
        cleaned = cleaned.replace(/<\/?(?:font|b|i|u|span|p|div|br)[^>]*>/gi, '');
        return cleaned;
    }

    function parseAiResponse(rawText, expectedInput) {
        const cleaned = cleanMarkdown(rawText);
        const resultMap = {};
        if (!cleaned.trim()) return resultMap;

        let expectedIdSet;
        const timelineToItemMap = new Map();
        const idToItemMap = new Map();

        if (Array.isArray(expectedInput)) {
            expectedIdSet = new Set(expectedInput.map(it => it.id));
            for (const it of expectedInput) {
                idToItemMap.set(it.id, it);
                if (it.normalizedTimeline) {
                    timelineToItemMap.set(it.normalizedTimeline, it);
                } else if (it.timeline) {
                    timelineToItemMap.set(normalizeTimeline(it.timeline), it);
                }
            }
        } else if (expectedInput instanceof Set) {
            expectedIdSet = expectedInput;
        } else {
            expectedIdSet = new Set();
        }

        const lines = cleaned.split('\n');
        const headerRegex = /^#\s*(\d+)[\s:：.\-]*(.*)$/;
        let currentId = null;
        let currentLines = [];

        function flushCurrent() {
            if (currentId !== null && expectedIdSet.has(currentId)) {
                let text = currentLines.join(' ').trim();
                if (text.includes('-->') || text.includes('->')) {
                    text = text.replace(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*(?:-->|->)\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g, '').trim();
                }
                if (text) {
                    resultMap[currentId] = text;
                }
            }
            currentId = null;
            currentLines = [];
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed) continue;

            const headerMatch = trimmed.match(headerRegex);
            if (headerMatch) {
                flushCurrent();
                const parsedId = parseInt(headerMatch[1], 10);
                if (expectedIdSet.has(parsedId)) {
                    currentId = parsedId;
                    const inlineText = headerMatch[2] ? headerMatch[2].trim() : '';
                    if (inlineText) {
                        currentLines.push(inlineText);
                    }
                }
            } else if (currentId !== null) {
                
                if (!trimmed.startsWith('```') && !trimmed.startsWith('===') && !trimmed.startsWith('---')) {
                    currentLines.push(trimmed);
                }
            }
        }
        flushCurrent();

        if (cleaned.includes('-->')) {
            const srtBlocks = cleaned.split(/\n\s*\n/);
            for (const block of srtBlocks) {
                const bLines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (bLines.length < 2) continue;

                let tIdx = -1;
                for (let j = 0; j < bLines.length; j++) {
                    if (bLines[j].includes('-->')) {
                        tIdx = j;
                        break;
                    }
                }
                if (tIdx === -1) continue;

                const rawBlockTimeline = bLines[tIdx];
                const normBlockTimeline = normalizeTimeline(rawBlockTimeline);

                let targetId = null;

                if (timelineToItemMap.has(normBlockTimeline)) {
                    targetId = timelineToItemMap.get(normBlockTimeline).id;
                }

                if (targetId === null && tIdx > 0) {
                    const idMatch = bLines[0].match(/#?\s*(\d+)/);
                    if (idMatch) {
                        const candId = parseInt(idMatch[1], 10);
                        if (expectedIdSet.has(candId)) {
                            if (timelineToItemMap.size === 0) {
                                targetId = candId;
                            } else {
                                const expectedItem = idToItemMap.get(candId);
                                if (expectedItem && expectedItem.normalizedTimeline === normBlockTimeline) {
                                    targetId = candId;
                                }
                            }
                        }
                    }
                }

                if (targetId !== null && expectedIdSet.has(targetId) && bLines.length > tIdx + 1) {
                    const trans = bLines.slice(tIdx + 1).join(' ').trim();
                    if (trans && !resultMap[targetId]) {
                        resultMap[targetId] = trans;
                    }
                }
            }
        }

        return resultMap;
    }

    function validateTranslationResults(expectedItems, parsedResultMap) {
        const completed = [];
        const missing = [];
        const invalid = [];

        for (const it of expectedItems) {
            if (parsedResultMap && parsedResultMap[it.id]) {
                const cand = parsedResultMap[it.id];
                const val = isTranslationValid(it.original, cand);
                if (val.valid) {
                    it.translated = cand;
                    it.status = 'completed';
                    it.errorReason = null;
                    completed.push(it);
                } else {
                    it.status = 'invalid';
                    it.errorReason = val.reason;
                    invalid.push(it);
                }
            } else {
                if (it.status !== 'completed') {
                    it.status = 'missing';
                    missing.push(it);
                }
            }
        }

        return { completed, missing, invalid };
    }

    function validateFinalExport(items) {
        if (!items || items.length === 0) {
            return { valid: false, reason: 'Danh sách phụ đề rỗng.' };
        }

        const uncompleted = items.filter(it => !it.translated || it.status !== 'completed');
        if (uncompleted.length > 0) {
            return {
                valid: false,
                reason: `Còn ${uncompleted.length} câu chưa hoàn thành dịch (ID: ${uncompleted.slice(0, 5).map(x => x.id).join(', ')}${uncompleted.length > 5 ? '...' : ''}).`,
                uncompletedIds: uncompleted.map(x => x.id)
            };
        }

        for (const it of items) {
            const check = isTranslationValid(it.original, it.translated);
            if (!check.valid) {
                return {
                    valid: false,
                    reason: `Câu #${it.id} không đạt chuẩn: ${check.reason}`,
                    invalidId: it.id
                };
            }
        }

        return { valid: true };
    }

    function calculateBatches(items, mode, batchSize) {
        const total = items ? items.length : 0;
        const size = (mode === 'all') ? total : (parseInt(batchSize, 10) || 100);
        const effectiveSize = size < 1 ? 1 : size;
        const totalBatches = Math.ceil(total / effectiveSize);
        const batches = [];
        for (let i = 0; i < totalBatches; i++) {
            const start = i * effectiveSize;
            const end = Math.min(start + effectiveSize, total);
            batches.push({
                batchIndex: i + 1,
                totalBatches: totalBatches,
                items: items.slice(start, end)
            });
        }
        return { totalBatches, batches, totalItems: total };
    }

    function buildBatchPrompt(activePrompt, batchItems) {
        const lines = batchItems.map(it => `#${it.id} ${it.original.replace(/\n/g, ' ')}`).join('\n');
        return `${activePrompt}\n\n${lines}`;
    }

    function buildRetryPrompt(missingItems) {
        const missingLines = missingItems.map(it => `#${it.id} ${it.original.replace(/\n/g, ' ')}`).join('\n');
        return `Dưới đây là các câu còn thiếu hoặc cần dịch lại từ lượt trước. Hãy dịch chuẩn xác sang tiếng Việt theo đúng ngữ cảnh đã dịch.\n\nYÊU CẦU BẮT BUỘC:\n1. CHỈ trả về đúng định dạng chuẩn: #ID <Bản dịch tiếng Việt>\n2. Bắt buộc giữ nguyên đúng số #ID của từng câu theo danh sách dưới đây, KHÔNG đánh lại số thứ tự từ 1.\n3. TUYỆT ĐỐI KHÔNG giải thích, không thêm lời chào, không dùng khối mã markdown (\`\`\`).\n\n${missingLines}`;
    }

    function buildRecoveryPrompt(activePrompt, contextItem, missingItems) {
        let contextBlock = '';
        const firstMissingId = (missingItems && missingItems.length > 0) ? missingItems[0].id : 1;
        if (contextItem) {
            contextBlock = `--- [DÒNG NGỮ CẢNH THAM CHIẾU - BẮT BUỘC ĐỌC KỸ] ---\nDưới đây là câu liền trước đã dịch thành công, cung cấp DUY NHẤT để bạn nắm bắt mạch nội dung:\n#${contextItem.id} [Gốc]: ${normalizeText(contextItem.original)}\n#${contextItem.id} [Đã dịch]: ${normalizeText(contextItem.translated || '')}\n\nQUY TẮC BẮT BUỘC VỀ DÒNG NGỮ CẢNH:\n- Đây là dòng ngữ cảnh để AI hiểu mạch nội dung.\n- AI TUYỆT ĐỐI KHÔNG ĐƯỢC dịch lại câu #${contextItem.id}.\n- AI TUYỆT ĐỐI KHÔNG ĐƯỢC đưa câu #${contextItem.id} vào kết quả trả về.\n- Bắt đầu dịch chính xác từ câu #${firstMissingId} (đoạn bị thiếu đầu tiên).\n- Giữ nguyên số thứ tự #${firstMissingId} trở đi và định dạng chuẩn.\n---------------------------------------------------\n\n`;
        }
        const missingLines = missingItems.map(it => `#${it.id} ${it.original}`).join('\n');
        return `${activePrompt}\n\n${contextBlock}DANH SÁCH CÁC CÂU CẦN DỊCH (Bắt đầu chính xác từ #${firstMissingId}):\n${missingLines}`;
    }

    function buildCompleteSrtContent(items) {
        const targetItems = items || currentSession.items;
        const exportCheck = validateFinalExport(targetItems);
        if (!exportCheck.valid) {
            throw new Error(`Kiểm tra xuất file thất bại: ${exportCheck.reason}`);
        }

        const blocks = [];
        for (let i = 0; i < targetItems.length; i++) {
            const it = targetItems[i];
            blocks.push(`${i + 1}\n${it.timeline}\n${it.translated}`);
        }
        return blocks.join('\n\n') + '\n';
    }

    function filterMissingItems(items) {
        if (!items) return [];
        const missing = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it && it.status !== 'completed') {
                missing.push(it);
            }
        }
        return missing;
    }

    function applyRecoveryResults(batchItems, parsedResults, contextItemId) {
        if (!batchItems || !parsedResults) return { recovered: 0, stillMissing: 0 };
        const itemMap = new Map();
        for (let i = 0; i < batchItems.length; i++) {
            const it = batchItems[i];
            if (it) itemMap.set(it.id, it);
        }

        const keys = Object.keys(parsedResults);
        for (let i = 0; i < keys.length; i++) {
            const idStr = keys[i];
            const id = parseInt(idStr, 10);
            if (contextItemId && id === contextItemId) continue;
            const it = itemMap.get(id);
            if (it) {
                const trans = parsedResults[idStr];
                const check = isTranslationValid(it.original, trans);
                if (check.valid) {
                    it.translated = trans;
                    it.status = 'completed';
                    it.errorReason = null;
                } else {
                    it.status = 'invalid';
                    it.errorReason = check.reason;
                }
            }
        }

        const missing = filterMissingItems(batchItems);
        return {
            recovered: batchItems.length - missing.length,
            stillMissing: missing.length
        };
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

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

    function sendViaKeyboardEnter(composer) {
        composer.focus();
        const evtDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const evtPress = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const evtUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        composer.dispatchEvent(evtDown);
        composer.dispatchEvent(evtPress);
        composer.dispatchEvent(evtUp);
    }

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

    function findNewChatButton() {
        
        const primarySelectors = [
            'div[role="button"].ds-button--iconLabelPrimary.ds-button--capsule',
            'div[role="button"][class*="ds-button--iconLabelPrimary"][class*="ds-button--capsule"]',
            'div[role="button"].ds-button--iconLabelPrimary',
            'div[role="button"][class*="ds-button--capsule"]:has(.ds-button__icon)'
        ];

        for (const sel of primarySelectors) {
            const buttons = document.querySelectorAll(sel);
            for (const btn of buttons) {
                
                if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
                
                if (btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled')) continue;

                const svg = btn.querySelector('.ds-button__icon svg, svg');
                if (svg) {
                    const vb = (svg.getAttribute('viewBox') || '').trim();
                    const w = (svg.getAttribute('width') || '').trim();
                    const h = (svg.getAttribute('height') || '').trim();
                    
                    if (vb === '0 0 20 20' || (w === '20' && h === '20') || vb === '0 0 16 16') {
                        return btn;
                    }
                }
            }
        }

        const allCandidates = document.querySelectorAll('div[role="button"], button');
        for (const c of allCandidates) {
            if (c.offsetParent === null && c.getClientRects().length === 0) continue;
            if (c.getAttribute('aria-disabled') === 'true' || c.hasAttribute('disabled')) continue;

            const svg = c.querySelector('svg');
            if (svg) {
                const vb = (svg.getAttribute('viewBox') || '').trim();
                const text = (c.innerText || '').trim().toLowerCase();
                const aria = (c.getAttribute('aria-label') || '').toLowerCase();
                if (vb === '0 0 20 20' || text.includes('new chat') || text.includes('chat mới') || aria.includes('new chat') || aria.includes('chat mới')) {
                    return c;
                }
            }
        }

        return null;
    }

    async function createNewChat(maxAttempts = 3) {
        console.log('%c[KageVietSub NewChat] Bắt đầu quy trình tạo hội thoại mới...', 'color: #00d2ff; font-weight: bold;');

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (currentSession.stopRequested) {
                console.log('[KageVietSub NewChat] Hủy tạo chat mới do người dùng yêu cầu dừng.');
                return false;
            }

            console.log(`[KageVietSub NewChat] Lần thử ${attempt}/${maxAttempts}:`);

            console.log('[KageVietSub NewChat] Bước 1: Đang tìm nút tạo chat mới theo cấu trúc chuẩn...');
            let newChatBtn = null;
            const findStart = Date.now();
            while (Date.now() - findStart < 4000) {
                newChatBtn = findNewChatButton();
                if (newChatBtn) break;
                await sleep(300);
            }

            if (!newChatBtn) {
                console.warn(`[KageVietSub NewChat] Lần ${attempt}: Không tìm thấy nút New Chat (capsule plus SVG). Đang thử lại...`);
                await sleep(1000);
                continue;
            }

            const isVisible = (newChatBtn.offsetParent !== null || newChatBtn.getClientRects().length > 0);
            const isDisabled = (newChatBtn.getAttribute('aria-disabled') === 'true' || newChatBtn.hasAttribute('disabled'));

            if (!isVisible || isDisabled) {
                console.warn(`[KageVietSub NewChat] Lần ${attempt}: Nút New Chat đang bị ẩn hoặc disabled.`);
                await sleep(1000);
                continue;
            }

            console.log('[KageVietSub NewChat] Bước 2: Đã xác định chính xác nút New Chat:', newChatBtn);

            const initialUrl = window.location.href;
            const initialMsgCount = getAssistantMessageCount();

            console.log('[KageVietSub NewChat] Bước 3: Đang click vào nút New Chat (duy nhất 1 lần)...');
            clickButton(newChatBtn);

            console.log('[KageVietSub NewChat] Bước 4: Đang chờ giao diện hội thoại mới xuất hiện...');
            const waitStart = Date.now();
            let stateChanged = false;

            while (Date.now() - waitStart < 6000) {
                if (currentSession.stopRequested) return false;

                const curUrl = window.location.href;
                const curMsgCount = getAssistantMessageCount();
                const curInput = findChatInput();

                if (curUrl !== initialUrl || curMsgCount < initialMsgCount || (curMsgCount === 0 && curInput)) {
                    stateChanged = true;
                    break;
                }
                await sleep(400);
            }

            console.log('[KageVietSub NewChat] Bước 5: Kiểm tra ô nhập tin nhắn...');
            await sleep(500);
            const finalInput = findChatInput();

            if (finalInput) {
                console.log('%c[KageVietSub NewChat] THÀNH CÔNG: Hội thoại mới và ô nhập tin nhắn đã sẵn sàng!', 'color: #10b981; font-weight: bold;');
                return true;
            } else {
                console.warn(`[KageVietSub NewChat] Lần ${attempt}: Ô nhập tin nhắn chưa sẵn sàng sau khi click.`);
                await sleep(1000);
            }
        }

        const errMsg = 'Không thể tạo cuộc trò chuyện mới trên DeepSeek sau 3 lần thử. Vui lòng kiểm tra lại giao diện.';
        console.error(`[KageVietSub NewChat] ${errMsg}`);
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
            
            console.log('[KageVietSub Send] Thực thi cơ chế DESKTOP: Gửi bằng phím Enter...');
            sendViaKeyboardEnter(input);

            await sleep(1500);
            const curVal = (input.tagName.toLowerCase() === 'textarea' ? input.value : input.innerText) || '';
            if (curVal.length > 0 && !isAiGenerating() && !isAiThinking()) {
                console.log('[KageVietSub Send] Thử lại Enter lần 2 trên PC...');
                sendViaKeyboardEnter(input);
            }
        } else {
            
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

    async function recoverDeepSeekLengthLimit(batchItems, activePrompt, batchIdx, totalBatches) {
        console.warn('[KageVietSub Recovery] Kích hoạt quy trình phục hồi Length Limit chuẩn PC...');
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

            const recoveryMessage = buildRecoveryPrompt(activePrompt, currentSession.lastCompletedItem, missingItemsList);

            const sent = await sendMessageAndWaitConfirmation(recoveryMessage);
            if (!sent) {
                await sleep(1000);
                continue;
            }

            const resp = await monitorAiResponse();
            const missingSet = new Set(missingItemsList.map(it => it.id));
            const parsed = parseAiResponse(resp, missingSet);

            applyRecoveryResults(batchItems, parsed, currentSession.lastCompletedItem ? currentSession.lastCompletedItem.id : null);
            updateSessionProgress();
        }

        const stillMissing = filterMissingItems(batchItems);
        return stillMissing.length === 0;
    }

    async function processBatchWithRetries(batchItems, activePrompt, batchIdx, totalBatches) {
        const expectedIds = batchItems.map(it => it.id);
        const expectedSet = new Set(expectedIds);
        const itemMap = new Map(batchItems.map(it => [it.id, it]));

        updateUIStatus(`Đang dịch đoạn ${batchIdx}/${totalBatches}...`);

        const initialPrompt = buildBatchPrompt(activePrompt, batchItems);

        const sent = await sendMessageAndWaitConfirmation(initialPrompt);
        if (!sent) {
            throw new Error(`Không thể gửi batch ${batchIdx} vào DeepSeek.`);
        }

        updateUIStatus(`Đang chờ DeepSeek trả lời đoạn ${batchIdx}/${totalBatches}...`);

        let responseText = '';
        try {
            responseText = await monitorAiResponse((text) => {
                const partial = parseAiResponse(text, batchItems);
                validateTranslationResults(batchItems, partial);
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

        const parsedResults = parseAiResponse(responseText, batchItems);
        validateTranslationResults(batchItems, parsedResults);

        let retryAttempt = 1;
        while (retryAttempt <= CONFIG.MAX_RETRIES && !currentSession.stopRequested) {
            const missingItems = filterMissingItems(batchItems);
            if (missingItems.length === 0) {
                break;
            }

            updateUIStatus(`Thiếu ${missingItems.length} câu. Đang xử lý lại (lần ${retryAttempt}/${CONFIG.MAX_RETRIES})...`);
            await sleep(1500);

            const retryMessage = buildRetryPrompt(missingItems);

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

            const retryParsed = parseAiResponse(retryResponse, missingItems);
            validateTranslationResults(missingItems, retryParsed);

            updateSessionProgress();
            retryAttempt++;
        }

        const stillMissing = filterMissingItems(batchItems);
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

        DeviceCompatibilityManager.detect();

        const customPromptText = (uiElements.customPromptInput ? uiElements.customPromptInput.value : '').trim();
        const activePrompt = customPromptText || CONFIG.DEFAULT_PROMPT;
        console.log(`[KageVietSub Prompt] Đang sử dụng: ${customPromptText ? 'PROMPT TÙY CHỈNH (In-memory)' : 'PROMPT GỐC CỦA TOOL PC'}`);

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

        const batchPlan = calculateBatches(currentSession.items, userSettings.mode, userSettings.batchSize);
        const totalBatches = batchPlan.totalBatches;
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
                const batchItems = batchPlan.batches[b].items;

                await processBatchWithRetries(batchItems, activePrompt, b + 1, totalBatches);

                if (b + 1 < totalBatches && !currentSession.stopRequested) {
                    updateUIStatus(`Đang tạo cuộc trò chuyện mới cho đoạn ${b + 2}/${totalBatches}...`);
                    await createNewChat();
                    await sleep(2000);
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
        promptBadge: null,
        customPromptInput: null,
        downloadSamplePromptBtn: null,
        clearPromptBtn: null,
        startBtn: null,
        progressLabel: null,
        progressBar: null,
        statusLabel: null,
        collapseBtn: null,
        contentBody: null,
        countLabel: null
    };

    const PositionManager = {
        STORAGE_KEY: 'kg_pref_widget_position',

        clamp(left, top, elemWidth, elemHeight) {
            const winW = window.innerWidth || document.documentElement.clientWidth || 390;
            const winH = window.innerHeight || document.documentElement.clientHeight || 844;
            const w = elemWidth || 350;

            const maxLeft = Math.max(0, winW - Math.min(w, winW));
            const clampedLeft = Math.max(0, Math.min(left, maxLeft));

            const maxTop = Math.max(0, winH - 45);
            const clampedTop = Math.max(0, Math.min(top, maxTop));

            return { left: Math.round(clampedLeft), top: Math.round(clampedTop) };
        },

        save(left, top) {
            try {
                StorageAdapter.set(this.STORAGE_KEY, { left, top, timestamp: Date.now() });
                console.log(`[PositionManager] Đã lưu vị trí menu: left=${left}px, top=${top}px`);
            } catch (e) {}
        },

        load() {
            try {
                const pos = StorageAdapter.get(this.STORAGE_KEY, null);
                if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                    return pos;
                }
            } catch (e) {}
            return null;
        },

        applySaved(container) {
            const pos = this.load();
            if (pos && container) {
                const rect = container.getBoundingClientRect();
                const w = rect.width || 350;
                const h = rect.height || 120;
                const clamped = this.clamp(pos.left, pos.top, w, h);
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

            let isDragging = false;
            let startPointerX = 0;
            let startPointerY = 0;
            let startLeft = 0;
            let startTop = 0;
            let hasMoved = false;

            headerEl.addEventListener('pointerdown', (e) => {
                
                if (e.button !== undefined && e.button !== 0) return;

                if (e.target.closest('button, #kg-collapse-btn, #kg-minimize-btn, #kg-vp-toggle-btn, input, select')) {
                    return;
                }

                const rect = containerEl.getBoundingClientRect();
                isDragging = true;
                hasMoved = false;
                startPointerX = e.clientX;
                startPointerY = e.clientY;
                startLeft = rect.left;
                startTop = rect.top;

                headerEl.style.cursor = 'grabbing';
                try {
                    headerEl.setPointerCapture(e.pointerId);
                } catch (err) {}
                e.preventDefault();
            });

            headerEl.addEventListener('pointermove', (e) => {
                if (!isDragging) return;

                const dx = e.clientX - startPointerX;
                const dy = e.clientY - startPointerY;

                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    hasMoved = true;
                }

                if (hasMoved) {
                    const rect = containerEl.getBoundingClientRect();
                    const rawLeft = startLeft + dx;
                    const rawTop = startTop + dy;
                    const clamped = PositionManager.clamp(rawLeft, rawTop, rect.width, rect.height);

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
                    if (headerEl.hasPointerCapture(e.pointerId)) {
                        headerEl.releasePointerCapture(e.pointerId);
                    }
                } catch (err) {}

                if (hasMoved) {
                    const rect = containerEl.getBoundingClientRect();
                    const clamped = PositionManager.clamp(rect.left, rect.top, rect.width, rect.height);
                    PositionManager.save(clamped.left, clamped.top);
                }
            };

            headerEl.addEventListener('pointerup', stopDrag);
            headerEl.addEventListener('pointercancel', stopDrag);

            window.addEventListener('resize', () => {
                if (containerEl && containerEl.style.left && containerEl.style.left !== 'auto') {
                    const rect = containerEl.getBoundingClientRect();
                    const curLeft = parseInt(containerEl.style.left, 10) || rect.left;
                    const curTop = parseInt(containerEl.style.top, 10) || rect.top;
                    const clamped = PositionManager.clamp(curLeft, curTop, rect.width, rect.height);
                    containerEl.style.left = `${clamped.left}px`;
                    containerEl.style.top = `${clamped.top}px`;
                }
            });
        }
    };

    function injectUI() {
        if (document.getElementById('kagevietsub-mobile-widget')) return;

        loadUserConfig();

        if (!document.getElementById('kg-widget-styles')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'kg-widget-styles';
            styleEl.textContent = `
                .kg-panel {
                    position: fixed;
                    top: 12px;
                    right: 12px;
                    width: calc(100vw - 24px);
                    max-width: 360px;
                    background: #111318;
                    color: #F1F4F9;
                    border: 1px solid #2A3241;
                    border-radius: 14px;
                    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7);
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 13px;
                    box-sizing: border-box;
                    user-select: none;
                    overflow: hidden;
                }
                .kg-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 14px;
                    background: #191D25;
                    border-bottom: 1px solid #2A3241;
                    cursor: grab;
                    touch-action: none;
                    user-select: none;
                }
                .kg-brand {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 700;
                    font-size: 13px;
                    letter-spacing: 0.5px;
                    color: #F1F4F9;
                }
                .kg-badge-sub {
                    font-size: 10px;
                    font-weight: 700;
                    background: rgba(77, 141, 255, 0.15);
                    color: #4D8DFF;
                    border: 1px solid rgba(77, 141, 255, 0.3);
                    padding: 2px 6px;
                    border-radius: 4px;
                    letter-spacing: 0.5px;
                }
                .kg-icon-btn {
                    width: 28px;
                    height: 28px;
                    border-radius: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                    border: none;
                    color: #9AA4B2;
                    cursor: pointer;
                    transition: background 0.15s, color 0.15s;
                }
                .kg-icon-btn:hover {
                    background: #202631;
                    color: #F1F4F9;
                }
                .kg-body {
                    padding: 12px 14px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    max-height: calc(100vh - 80px);
                    overflow-y: auto;
                    background: #111318;
                    box-sizing: border-box;
                }
                .kg-card {
                    background: #191D25;
                    border: 1px solid #2A3241;
                    border-radius: 9px;
                    padding: 10px 12px;
                    display: flex;
                    flex-direction: column;
                    gap: 7px;
                    box-sizing: border-box;
                }
                .kg-file-btn {
                    background: #202631;
                    color: #F1F4F9;
                    border: 1px dashed #4D8DFF;
                    border-radius: 8px;
                    padding: 9px 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    width: 100%;
                    min-height: 42px;
                    box-sizing: border-box;
                    transition: all 0.2s;
                }
                .kg-file-btn:hover {
                    background: rgba(77, 141, 255, 0.12);
                    border-color: #6FA2FF;
                }
                .kg-file-meta {
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    font-size: 12px;
                    color: #9AA4B2;
                }
                .kg-file-meta-val {
                    color: #F1F4F9;
                    font-weight: 500;
                }
                .kg-label {
                    font-size: 11px;
                    font-weight: 600;
                    color: #9AA4B2;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .kg-select {
                    background: #202631;
                    color: #F1F4F9;
                    border: 1px solid #2A3241;
                    border-radius: 7px;
                    padding: 8px 10px;
                    font-size: 13px;
                    cursor: pointer;
                    outline: none;
                    min-height: 38px;
                    box-sizing: border-box;
                    width: 100%;
                }
                .kg-select:focus, .kg-input:focus, .kg-textarea:focus {
                    border-color: #4D8DFF;
                }
                .kg-input {
                    background: #202631;
                    color: #F1F4F9;
                    border: 1px solid #2A3241;
                    border-radius: 7px;
                    padding: 7px 10px;
                    font-size: 13px;
                    outline: none;
                    box-sizing: border-box;
                }
                .kg-accordion {
                    background: #191D25;
                    border: 1px solid #2A3241;
                    border-radius: 9px;
                    overflow: hidden;
                    box-sizing: border-box;
                }
                .kg-accordion-header {
                    padding: 9px 12px;
                    background: #191D25;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: pointer;
                    user-select: none;
                    font-size: 12px;
                    font-weight: 600;
                    color: #F1F4F9;
                }
                .kg-badge-default {
                    font-size: 10px;
                    font-weight: 600;
                    color: #20B982;
                    background: rgba(32, 185, 130, 0.12);
                    border: 1px solid rgba(32, 185, 130, 0.3);
                    padding: 2px 7px;
                    border-radius: 4px;
                }
                .kg-badge-custom {
                    font-size: 10px;
                    font-weight: 600;
                    color: #4D8DFF;
                    background: rgba(77, 141, 255, 0.12);
                    border: 1px solid rgba(77, 141, 255, 0.3);
                    padding: 2px 7px;
                    border-radius: 4px;
                }
                .kg-accordion-body {
                    display: none;
                    padding: 10px 12px;
                    flex-direction: column;
                    gap: 8px;
                    border-top: 1px solid #2A3241;
                    background: #15181F;
                    box-sizing: border-box;
                }
                .kg-textarea {
                    width: 100%;
                    min-height: 80px;
                    max-height: 160px;
                    background: #202631;
                    color: #F1F4F9;
                    border: 1px solid #2A3241;
                    border-radius: 7px;
                    padding: 8px 10px;
                    font-size: 11px;
                    font-family: inherit;
                    resize: vertical;
                    box-sizing: border-box;
                    outline: none;
                    line-height: 1.45;
                }
                .kg-sub-btn {
                    background: #202631;
                    color: #4D8DFF;
                    border: 1px solid rgba(77, 141, 255, 0.4);
                    border-radius: 6px;
                    padding: 6px 10px;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    min-height: 32px;
                    box-sizing: border-box;
                    transition: all 0.15s;
                }
                .kg-sub-btn:hover {
                    background: rgba(77, 141, 255, 0.15);
                }
                .kg-clear-btn {
                    color: #9AA4B2;
                    border-color: #333C4D;
                }
                .kg-clear-btn:hover {
                    background: #2A3241;
                    color: #F1F4F9;
                }
                .kg-primary-btn {
                    background: #4D8DFF;
                    color: #FFFFFF;
                    border: none;
                    border-radius: 8px;
                    padding: 12px 16px;
                    font-size: 14px;
                    font-weight: 700;
                    cursor: pointer;
                    width: 100%;
                    min-height: 44px;
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    letter-spacing: 0.5px;
                    touch-action: manipulation;
                    transition: background 0.2s, opacity 0.2s;
                }
                .kg-primary-btn:hover:not(:disabled) {
                    background: #3B7BE8;
                }
                .kg-primary-btn:disabled {
                    opacity: 0.45;
                    cursor: not-allowed;
                }
                .kg-stop-btn {
                    background: #E45B65 !important;
                }
                .kg-stop-btn:hover {
                    background: #C7454F !important;
                }
                .kg-progress-track {
                    width: 100%;
                    height: 7px;
                    background: #202631;
                    border-radius: 4px;
                    overflow: hidden;
                }
                .kg-progress-fill {
                    width: 0%;
                    height: 100%;
                    background: #4D8DFF;
                    border-radius: 4px;
                    transition: width 0.3s ease;
                }
                .kg-status-box {
                    font-size: 12px;
                    color: #9AA4B2;
                    min-height: 18px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    padding: 2px 0;
                }
                .kg-resume-card {
                    display: none;
                    background: #191D25;
                    border: 1px solid #4D8DFF;
                    border-radius: 8px;
                    padding: 10px;
                    flex-direction: column;
                    gap: 8px;
                }
            `;
            document.head.appendChild(styleEl);
        }

        const container = document.createElement('div');
        container.id = 'kagevietsub-mobile-widget';
        container.className = 'kg-panel';

        container.innerHTML = `
            <div id="kg-header" class="kg-header">
                <div class="kg-brand">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4D8DFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                        <polyline points="2 17 12 22 22 17"></polyline>
                        <polyline points="2 12 12 17 22 12"></polyline>
                    </svg>
                    <span>KAGEVIETSUB</span>
                    <span class="kg-badge-sub">TRANSLATOR</span>
                </div>
                <button id="kg-collapse-btn" class="kg-icon-btn" title="Thu gọn/Mở rộng">
                    <svg id="kg-collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            </div>

            <div id="kg-body" class="kg-body">
                <input type="file" id="kg-file-input" accept=".srt" style="display: none;" />

                <div class="kg-card">
                    <button id="kg-select-file-btn" class="kg-file-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4D8DFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="12" y1="18" x2="12" y2="12"></line>
                            <line x1="9" y1="15" x2="15" y2="15"></line>
                        </svg>
                        <span>[ Chọn file SRT ]</span>
                    </button>
                    <div class="kg-file-meta">
                        <div id="kg-filename-label" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            Tên file: <span class="kg-file-meta-val">(Chưa chọn)</span>
                        </div>
                        <div id="kg-total-count-label">
                            Tổng phụ đề: <span class="kg-file-meta-val">0 dòng</span>
                        </div>
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
                            <option value="custom">Tùy chỉnh số dòng...</option>
                        </select>
                        <input type="number" id="kg-batch-custom-input" class="kg-input" min="5" max="1000" placeholder="Số dòng" style="display: none; width: 90px;" />
                    </div>
                </div>

                <!-- KHU VỰC PROMPT AI (TÙY CHỌN) -->
                <div class="kg-accordion">
                    <div id="kg-prompt-header" class="kg-accordion-header">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4D8DFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                            <span>PROMPT AI</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span id="kg-prompt-badge" class="kg-badge-default">[ Mặc định ]</span>
                            <span id="kg-prompt-toggle-btn" style="color: #4D8DFF; font-weight: bold; font-size: 14px;">+</span>
                        </div>
                    </div>
                    <div id="kg-prompt-body" class="kg-accordion-body">
                        <textarea id="kg-custom-prompt-input" class="kg-textarea" placeholder="Để trống để sử dụng Prompt mặc định của KAGEVIETSUB. Nhập nội dung tại đây nếu muốn thay thế prompt mặc định trong phiên hiện tại..."></textarea>
                        <div style="display: flex; gap: 6px;">
                            <button id="kg-download-sample-prompt-btn" type="button" class="kg-sub-btn" style="flex: 1;">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                                <span>Tải Prompt mẫu</span>
                            </button>
                            <button id="kg-clear-prompt-btn" type="button" class="kg-sub-btn kg-clear-btn">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                                <span>Xóa</span>
                            </button>
                        </div>
                    </div>
                </div>

                <button id="kg-start-btn" class="kg-primary-btn" disabled>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                    <span>BẮT ĐẦU DỊCH</span>
                </button>

                <div style="border-top: 1px dashed #2A3241; margin: 2px 0;"></div>

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span id="kg-progress-label" style="font-weight: 600; color: #F1F4F9; font-size: 12px;">Tiến trình: 0%</span>
                    <span id="kg-count-label" style="color: #9AA4B2; font-size: 11px;">0/0 câu</span>
                </div>

                <div class="kg-progress-track">
                    <div id="kg-progress-bar" class="kg-progress-fill"></div>
                </div>

                <div id="kg-status-label" class="kg-status-box" title="Đang chờ bắt đầu...">Đang chờ bắt đầu...</div>

                <div id="kg-resume-banner" class="kg-resume-card">
                    <span style="color: #4D8DFF; font-weight: 600; font-size: 12px;">Tìm thấy phiên dịch dở dang!</span>
                    <div style="display: flex; gap: 6px;">
                        <button id="kg-resume-btn" style="flex: 1; background: #20B982; color: white; border: none; border-radius: 6px; padding: 7px; font-size: 12px; font-weight: 600; cursor: pointer;">Tiếp tục</button>
                        <button id="kg-discard-btn" style="flex: 1; background: #E45B65; color: white; border: none; border-radius: 6px; padding: 7px; font-size: 12px; font-weight: 600; cursor: pointer;">Hủy bỏ</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

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
        uiElements.promptBadge = container.querySelector('#kg-prompt-badge');
        uiElements.customPromptInput = container.querySelector('#kg-custom-prompt-input');
        uiElements.downloadSamplePromptBtn = container.querySelector('#kg-download-sample-prompt-btn');
        uiElements.clearPromptBtn = container.querySelector('#kg-clear-prompt-btn');
        uiElements.startBtn = container.querySelector('#kg-start-btn');
        uiElements.progressLabel = container.querySelector('#kg-progress-label');
        uiElements.progressBar = container.querySelector('#kg-progress-bar');
        uiElements.statusLabel = container.querySelector('#kg-status-label');
        uiElements.collapseBtn = container.querySelector('#kg-collapse-btn');
        uiElements.contentBody = container.querySelector('#kg-body');
        uiElements.countLabel = container.querySelector('#kg-count-label');

        syncConfigToUI();

        let isPromptExpanded = false;
        container.querySelector('#kg-prompt-header').addEventListener('click', () => {
            isPromptExpanded = !isPromptExpanded;
            uiElements.promptBody.style.display = isPromptExpanded ? 'flex' : 'none';
            uiElements.promptToggleBtn.innerText = isPromptExpanded ? '−' : '+';
        });

        function updatePromptBadge() {
            if (!uiElements.promptBadge) return;
            const val = (uiElements.customPromptInput ? uiElements.customPromptInput.value : '').trim();
            if (val) {
                uiElements.promptBadge.innerText = '[ Tùy chỉnh ]';
                uiElements.promptBadge.className = 'kg-badge-custom';
            } else {
                uiElements.promptBadge.innerText = '[ Mặc định ]';
                uiElements.promptBadge.className = 'kg-badge-default';
            }
        }

        uiElements.customPromptInput.addEventListener('input', updatePromptBadge);
        uiElements.customPromptInput.addEventListener('change', updatePromptBadge);

        uiElements.clearPromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (uiElements.customPromptInput) {
                uiElements.customPromptInput.value = '';
            }
            updatePromptBadge();
            updateUIStatus('Đã khôi phục Prompt AI về mặc định.');
        });

        uiElements.downloadSamplePromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadSamplePrompt();
        });

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

                    uiElements.fileNameLabel.innerHTML = `Tên file: <span class="kg-file-meta-val" title="${file.name}">${file.name}</span>`;
                    uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span class="kg-file-meta-val">${items.length.toLocaleString('vi-VN')} dòng</span>`;

                    uiElements.startBtn.disabled = false;
                    uiElements.startBtn.className = 'kg-primary-btn';
                    uiElements.startBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>BẮT ĐẦU DỊCH</span>';

                    updateSessionProgress();
                    updateUIStatus('Đã đọc file xong. Hãy xác nhận chế độ và nhấn [ BẮT ĐẦU DỊCH ].');
                } catch (err) {
                    alert('Lỗi khi đọc file SRT: ' + err);
                    updateUIStatus('Lỗi đọc file.');
                }
            };

            reader.readAsText(file, 'utf-8');
        });

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

        let isCollapsed = false;
        uiElements.collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isCollapsed = !isCollapsed;
            if (isCollapsed) {
                uiElements.contentBody.style.display = 'none';
                uiElements.collapseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
                container.style.width = 'auto';
            } else {
                uiElements.contentBody.style.display = 'flex';
                uiElements.collapseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
                container.style.width = 'calc(100vw - 24px)';
            }
        });

        PositionManager.attachDrag(uiElements.header, container);
        PositionManager.applySaved(container);

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
        const translatedCount = currentSession.items.filter(it => it.translated && (it.status === 'completed' || it.status === 'translated')).length;
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
            uiElements.startBtn.className = 'kg-primary-btn kg-stop-btn';
            uiElements.startBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg><span>DỪNG DỊCH</span>';
            uiElements.selectFileBtn.style.pointerEvents = 'none';
            uiElements.selectFileBtn.style.opacity = '0.5';
            uiElements.modeSelect.disabled = true;
            uiElements.batchSelect.disabled = true;
            if (uiElements.batchCustomInput) uiElements.batchCustomInput.disabled = true;
        } else {
            uiElements.startBtn.className = 'kg-primary-btn';
            uiElements.startBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>BẮT ĐẦU DỊCH</span>';
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
            const translatedCount = saved.items.filter(it => it.translated && (it.status === 'completed' || it.status === 'translated')).length;
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
                            uiElements.fileNameLabel.innerHTML = `Tên file: <span class="kg-file-meta-val" title="${saved.fileName}">${saved.fileName}</span>`;
                        }
                        if (uiElements.totalCountLabel) {
                            uiElements.totalCountLabel.innerHTML = `Tổng phụ đề: <span class="kg-file-meta-val">${saved.items.length.toLocaleString('vi-VN')} dòng</span>`;
                        }
                        if (uiElements.startBtn) {
                            uiElements.startBtn.disabled = false;
                            uiElements.startBtn.className = 'kg-primary-btn';
                            uiElements.startBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>BẮT ĐẦU DỊCH</span>';
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

    window.addEventListener('load', () => {
        setTimeout(injectUI, 1200);
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(injectUI, 1000);
    }

})();
