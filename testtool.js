// ==UserScript==
// @name         KAGEVIETSUB Desktop Mode Test
// @namespace    https://github.com/nguyenducmanh2222011-oss/tool
// @version      1.0.0
// @description  Userscript thử nghiệm độc lập: Tự động kiểm tra và thử nghiệm chuyển đổi giao diện DeepSeek sang Desktop Mode trên điện thoại
// @author       KageVietSub Team
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * ============================================================================
 * KAGEVIETSUB DESKTOP MODE TEST (STANDALONE DIAGNOSTIC & EXPERIMENTAL TOOL)
 * ============================================================================
 *
 * MỤC ĐÍCH:
 * - Userscript độc lập kiểm tra khả năng nhận diện thiết bị (Mobile vs Desktop)
 *   và thử nghiệm thiết lập viewport desktop phía client trên trang DeepSeek Chat.
 * - KHÔNG có tính năng dịch SRT.
 * - KHÔNG gửi tin nhắn, không can thiệp tài khoản hoặc dữ liệu người dùng.
 * - TUYỆT ĐỐI KHÔNG làm ảnh hưởng đến mã nguồn gốc của KAGEVIETSUB.
 * ============================================================================
 */

(function () {
    'use strict';

    // Ngăn chặn chạy trùng lặp nếu script được chèn nhiều lần
    if (window.__KAGEVIETSUB_DESKTOP_TEST_LOADED__) {
        console.warn('[KageVietSub Desktop Test] Script đã được nạp trước đó, bỏ qua khởi tạo trùng lặp.');
        return;
    }
    window.__KAGEVIETSUB_DESKTOP_TEST_LOADED__ = true;

    // =========================================================================
    // 1. MODULE NHẬN DIỆN THIẾT BỊ (DEVICE DETECTOR)
    // =========================================================================
    const DeviceDetector = {
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

            // 3. Kiểm tra User Agent di động
            const isMobileUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
            const isIpadOs = platform.includes('mac') && hasTouch && (navigator.maxTouchPoints > 1);

            // 4. Kích thước màn hình vật lý & Viewport
            const screenW = window.screen.width;
            const screenH = window.screen.height;
            const innerW = window.innerWidth;
            const innerH = window.innerHeight;
            const isSmallScreen = innerW <= 768 || screenW <= 768;

            // Xác định loại thiết bị
            let deviceType = 'DESKTOP';
            if (hasTouch && (isMobileUa || isIpadOs || isCoarse || isSmallScreen)) {
                deviceType = 'MOBILE';
            } else if (hasTouch && (innerW > 768 && innerW <= 1024)) {
                deviceType = 'TABLET';
            } else if (!hasTouch && innerW > 1024) {
                deviceType = 'DESKTOP';
            } else {
                deviceType = isMobileUa ? 'MOBILE' : 'DESKTOP';
            }

            return {
                deviceType,
                hasTouch,
                isCoarse,
                isMobileUa,
                isIpadOs,
                ua: navigator.userAgent,
                platform: navigator.platform,
                screenWidth: screenW,
                screenHeight: screenH,
                viewportWidth: innerW,
                viewportHeight: innerH,
                dpr: window.devicePixelRatio || 1
            };
        }
    };

    // =========================================================================
    // 2. MODULE QUẢN LÝ VIEWPORT (VIEWPORT MANAGER)
    // =========================================================================
    const ViewportManager = {
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

        getCurrentContent() {
            const meta = document.querySelector('meta[name="viewport"]');
            return meta ? (meta.getAttribute('content') || '(trống)') : '(không tìm thấy thẻ meta)';
        },

        applyDesktopViewport(targetWidth = 1280) {
            const meta = this.getMetaElement();
            if (!this.originalContent) {
                this.originalContent = meta.getAttribute('content') || 'width=device-width, initial-scale=1.0';
            }

            // Thiết lập viewport cố định kích thước máy tính (1280px)
            // Tỷ lệ thu nhỏ thích hợp để vừa màn hình điện thoại
            const currentScreenWidth = window.screen.width || 390;
            const targetScale = Math.max(0.25, Math.min(1.0, currentScreenWidth / targetWidth)).toFixed(2);
            const newContent = `width=${targetWidth}, initial-scale=${targetScale}, maximum-scale=3.0, user-scalable=yes`;

            meta.setAttribute('content', newContent);
            this.isCustomized = true;

            // Kích hoạt sự kiện resize giả để các component responsive của trang cập nhật
            window.dispatchEvent(new Event('resize'));
            return {
                applied: true,
                newContent,
                scale: targetScale
            };
        },

        restoreOriginal() {
            if (!this.originalContent) return false;
            const meta = this.getMetaElement();
            meta.setAttribute('content', this.originalContent);
            this.isCustomized = false;
            window.dispatchEvent(new Event('resize'));
            return true;
        }
    };

    // =========================================================================
    // 3. MODULE KIỂM TRA GIAO DIỆN DEEPSEEK (DEEPSEEK INTERFACE INSPECTOR)
    // =========================================================================
    const DeepSeekInspector = {
        inspect() {
            // 1. Selector sidebar desktop
            const desktopSidebar = document.querySelector(
                'aside, div[class*="sidebar"], div[class*="chat-sidebar"], .ds-sidebar, div[role="navigation"]'
            );
            const hasSidebarVisible = Boolean(desktopSidebar && desktopSidebar.offsetWidth > 0 && desktopSidebar.offsetHeight > 0);

            // 2. Selector menu mobile / Hamburger
            const mobileMenuBtn = document.querySelector(
                'button[aria-label*="menu"], div[role="button"][class*="menu"], svg[class*="menu"], div[class*="mobile-header"]'
            );
            const hasMobileMenu = Boolean(mobileMenuBtn && mobileMenuBtn.offsetWidth > 0);

            // 3. Khung nhập tin nhắn
            const chatInput = document.querySelector(
                'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea[placeholder*="Message"], textarea, div[contenteditable="true"]'
            );
            const hasInput = Boolean(chatInput);

            // 4. Nút gửi
            const sendBtn = document.querySelector(
                'div[role="button"].ds-button--primary, div[role="button"][class*="ds-button--primary"], div[role="button"][aria-label*="Send"], div[role="button"][aria-label*="Gửi"]'
            );
            const hasSendBtn = Boolean(sendBtn);

            // 5. Xác định giao diện DeepSeek hiện tại
            const innerW = window.innerWidth;
            let detectedLayout = 'UNKNOWN';

            if (innerW >= 1024 || (hasSidebarVisible && !hasMobileMenu)) {
                detectedLayout = 'DESKTOP_LAYOUT';
            } else if (innerW < 768 || hasMobileMenu) {
                detectedLayout = 'MOBILE_LAYOUT';
            } else {
                detectedLayout = 'TABLET_TRANSITIONAL';
            }

            return {
                detectedLayout,
                hasSidebar: Boolean(desktopSidebar),
                isSidebarVisible: hasSidebarVisible,
                hasMobileMenu,
                hasInput,
                hasSendBtn,
                inputTagName: chatInput ? chatInput.tagName.toLowerCase() : 'none',
                innerWidth: innerW,
                innerHeight: window.innerHeight
            };
        }
    };

    // =========================================================================
    // 4. GIAO DIỆN ĐIỀU KHIỂN & HIỂN THỊ KẾT QUẢ (UI CONTROLLER)
    // =========================================================================
    const UIController = {
        container: null,
        isMinimized: false,

        injectStyles() {
            if (document.getElementById('kg-desktop-test-styles')) return;
            const style = document.createElement('style');
            style.id = 'kg-desktop-test-styles';
            style.textContent = `
                #kg-dt-panel {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 340px;
                    max-width: calc(100vw - 30px);
                    background: #14171f;
                    border: 1px solid #2e384d;
                    border-radius: 12px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
                    color: #e2e8f0;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 12px;
                    z-index: 9999999;
                    box-sizing: border-box;
                    overflow: hidden;
                    transition: all 0.25s ease;
                }
                #kg-dt-panel * {
                    box-sizing: border-box;
                }
                .kg-dt-header {
                    background: #1e2433;
                    padding: 10px 14px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    border-bottom: 1px solid #2e384d;
                    font-weight: 700;
                    font-size: 13px;
                    color: #00d2ff;
                    cursor: move;
                }
                .kg-dt-header-btns {
                    display: flex;
                    gap: 6px;
                }
                .kg-dt-icon-btn {
                    background: transparent;
                    border: 1px solid #3b4760;
                    color: #94a3b8;
                    border-radius: 6px;
                    width: 24px;
                    height: 24px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 14px;
                    line-height: 1;
                }
                .kg-dt-icon-btn:hover {
                    color: #ffffff;
                    border-color: #00d2ff;
                }
                .kg-dt-body {
                    padding: 12px 14px;
                    max-height: 75vh;
                    overflow-y: auto;
                }
                .kg-dt-section {
                    margin-bottom: 12px;
                    background: #1a202c;
                    border: 1px solid #2d3748;
                    border-radius: 8px;
                    padding: 10px;
                }
                .kg-dt-section-title {
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: #94a3b8;
                    margin-bottom: 8px;
                    font-weight: 600;
                    display: flex;
                    justify-content: space-between;
                }
                .kg-dt-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 5px;
                    align-items: center;
                }
                .kg-dt-label {
                    color: #94a3b8;
                }
                .kg-dt-value {
                    font-weight: 600;
                    color: #f1f5f9;
                    text-align: right;
                    word-break: break-all;
                }
                .kg-dt-badge {
                    display: inline-block;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 11px;
                    font-weight: 700;
                }
                .kg-dt-badge-mobile {
                    background: rgba(245, 158, 11, 0.2);
                    color: #f59e0b;
                    border: 1px solid #f59e0b;
                }
                .kg-dt-badge-desktop {
                    background: rgba(16, 185, 129, 0.2);
                    color: #10b981;
                    border: 1px solid #10b981;
                }
                .kg-dt-badge-warn {
                    background: rgba(239, 68, 68, 0.2);
                    color: #ef4444;
                    border: 1px solid #ef4444;
                }
                .kg-dt-actions {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-top: 10px;
                }
                .kg-dt-btn {
                    width: 100%;
                    padding: 9px 12px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 12px;
                    cursor: pointer;
                    border: none;
                    transition: all 0.2s ease;
                    text-align: center;
                }
                .kg-dt-btn-primary {
                    background: linear-gradient(135deg, #0070f3, #00d2ff);
                    color: #ffffff;
                }
                .kg-dt-btn-primary:hover {
                    opacity: 0.9;
                }
                .kg-dt-btn-secondary {
                    background: #2a3346;
                    color: #cbd5e1;
                    border: 1px solid #3e4c66;
                }
                .kg-dt-btn-secondary:hover {
                    background: #364259;
                    color: #ffffff;
                }
                .kg-dt-btn-restore {
                    background: #332029;
                    color: #fca5a5;
                    border: 1px solid #7f1d1d;
                }
                .kg-dt-btn-restore:hover {
                    background: #491f28;
                }
                .kg-dt-notice {
                    margin-top: 10px;
                    padding: 8px;
                    border-radius: 6px;
                    background: rgba(234, 179, 8, 0.1);
                    border: 1px solid rgba(234, 179, 8, 0.3);
                    color: #fef08a;
                    font-size: 11px;
                    line-height: 1.4;
                }
                .kg-dt-minimized {
                    width: 170px !important;
                    height: 42px !important;
                    overflow: hidden !important;
                }
            `;
            document.head.appendChild(style);
        },

        render() {
            this.injectStyles();

            let panel = document.getElementById('kg-dt-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'kg-dt-panel';
                document.body.appendChild(panel);
            }
            this.container = panel;
            this.update();
        },

        update() {
            if (!this.container) return;

            const dev = DeviceDetector.detect();
            const viewCurrent = ViewportManager.getCurrentContent();
            const insp = DeepSeekInspector.inspect();

            const isDesktopDev = dev.deviceType === 'DESKTOP';
            const devBadgeClass = isDesktopDev ? 'kg-dt-badge-desktop' : 'kg-dt-badge-mobile';

            const isDesktopLayout = insp.detectedLayout === 'DESKTOP_LAYOUT';
            const layoutBadgeClass = isDesktopLayout ? 'kg-dt-badge-desktop' : 'kg-dt-badge-warn';
            const layoutLabel = isDesktopLayout ? 'DESKTOP' : (insp.detectedLayout === 'MOBILE_LAYOUT' ? 'MOBILE' : 'TRANSITIONAL');

            this.container.innerHTML = `
                <div class="kg-dt-header">
                    <span>🖥️ KAGEVIETSUB Desktop Test</span>
                    <div class="kg-dt-header-btns">
                        <button class="kg-dt-icon-btn" id="kg-dt-btn-min" title="Thu nhỏ / Phóng to">${this.isMinimized ? '+' : '−'}</button>
                        <button class="kg-dt-icon-btn" id="kg-dt-btn-close" title="Đóng panel">✕</button>
                    </div>
                </div>
                ${this.isMinimized ? '' : `
                <div class="kg-dt-body">
                    <!-- Section 1: Thiết bị & Viewport -->
                    <div class="kg-dt-section">
                        <div class="kg-dt-section-title">
                            <span>1. NHẬN DIỆN THIẾT BỊ</span>
                            <span class="kg-dt-badge ${devBadgeClass}">${dev.deviceType}</span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Touch Screen:</span>
                            <span class="kg-dt-value">${dev.hasTouch ? 'Có (' + (navigator.maxTouchPoints || 1) + ' điểm)' : 'Không'}</span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Con trỏ cảm ứng:</span>
                            <span class="kg-dt-value">${dev.isCoarse ? 'Coarse (Ngón tay)' : 'Fine (Chuột)'}</span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Màn hình vật lý:</span>
                            <span class="kg-dt-value">${dev.screenWidth} × ${dev.screenHeight} (DPR: ${dev.dpr})</span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Viewport hiện tại:</span>
                            <span class="kg-dt-value" style="color: #00d2ff;">${dev.viewportWidth} × ${dev.viewportHeight}</span>
                        </div>
                    </div>

                    <!-- Section 2: Giao diện DeepSeek -->
                    <div class="kg-dt-section">
                        <div class="kg-dt-section-title">
                            <span>2. GIAO DIỆN DEEPSEEK</span>
                            <span class="kg-dt-badge ${layoutBadgeClass}">${layoutLabel}</span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Sidebar Desktop:</span>
                            <span class="kg-dt-value" style="color: ${insp.isSidebarVisible ? '#10b981' : '#94a3b8'};">
                                ${insp.isSidebarVisible ? '✅ Đang hiển thị' : (insp.hasSidebar ? '⚠️ Ẩn trong DOM' : '❌ Không có')}
                            </span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Menu Hamburger:</span>
                            <span class="kg-dt-value" style="color: ${insp.hasMobileMenu ? '#f59e0b' : '#94a3b8'};">
                                ${insp.hasMobileMenu ? '📱 Có (Chế độ Mobile)' : 'Không (Ẩn)'}
                            </span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Khung nhập tin nhắn:</span>
                            <span class="kg-dt-value" style="color: ${insp.hasInput ? '#10b981' : '#ef4444'};">
                                ${insp.hasInput ? '✅ Tìm thấy (' + insp.inputTagName + ')' : '❌ Chưa sẵn sàng'}
                            </span>
                        </div>
                        <div class="kg-dt-row">
                            <span class="kg-dt-label">Nút gửi (Send button):</span>
                            <span class="kg-dt-value" style="color: ${insp.hasSendBtn ? '#10b981' : '#ef4444'};">
                                ${insp.hasSendBtn ? '✅ Tìm thấy' : '❌ Chưa sẵn sàng'}
                            </span>
                        </div>
                    </div>

                    <!-- Section 3: Thẻ Meta Viewport -->
                    <div class="kg-dt-section">
                        <div class="kg-dt-section-title">
                            <span>3. THẺ META VIEWPORT</span>
                            <span class="kg-dt-badge" style="background:#2a3346; color:#93c5fd;">
                                ${ViewportManager.isCustomized ? 'ĐÃ ĐỔI 1280PX' : 'NGUYÊN BẢN'}
                            </span>
                        </div>
                        <div style="font-family: monospace; font-size: 10px; color: #cbd5e1; background: #0f141d; padding: 6px; border-radius: 4px; word-break: break-all;">
                            ${viewCurrent}
                        </div>
                    </div>

                    <!-- Section 4: Nút thao tác -->
                    <div class="kg-dt-actions">
                        <button class="kg-dt-btn kg-dt-btn-primary" id="kg-dt-btn-switch">
                            🖥️ Thử chuyển Desktop Mode (1280px)
                        </button>
                        <button class="kg-dt-btn kg-dt-btn-secondary" id="kg-dt-btn-check">
                            🔄 Kiểm tra lại giao diện
                        </button>
                        <button class="kg-dt-btn kg-dt-btn-restore" id="kg-dt-btn-restore">
                            ↩️ Khôi phục Viewport ban đầu
                        </button>
                    </div>

                    <!-- Section 5: Khuyến cáo kỹ thuật -->
                    <div class="kg-dt-notice">
                        ⚠️ <b>Lưu ý kỹ thuật quan trọng:</b><br>
                        Việc đổi thẻ meta viewport chỉ tác động đến CSS media queries phía client. Nó <b>KHÔNG</b> thay đổi User-Agent của trình duyệt.<br>
                        Nếu DeepSeek vẫn giữ bố cục di động, hãy bật trực tiếp tùy chọn <b>"Trang web cho máy tính" (Request Desktop Site)</b> trong menu cài đặt của trình duyệt di động.
                    </div>
                </div>
                `}
            `;

            // Gán sự kiện cho các nút bấm
            this.bindEvents();
        },

        bindEvents() {
            const btnMin = document.getElementById('kg-dt-btn-min');
            if (btnMin) {
                btnMin.onclick = () => {
                    this.isMinimized = !this.isMinimized;
                    if (this.isMinimized) {
                        this.container.classList.add('kg-dt-minimized');
                    } else {
                        this.container.classList.remove('kg-dt-minimized');
                    }
                    this.update();
                };
            }

            const btnClose = document.getElementById('kg-dt-btn-close');
            if (btnClose) {
                btnClose.onclick = () => {
                    if (confirm('Bạn có muốn ẩn bảng kiểm tra Desktop Mode? Tải lại trang sẽ hiển thị lại.')) {
                        this.container.style.display = 'none';
                    }
                };
            }

            const btnSwitch = document.getElementById('kg-dt-btn-switch');
            if (btnSwitch) {
                btnSwitch.onclick = () => {
                    const res = ViewportManager.applyDesktopViewport(1280);
                    console.log('[KageVietSub Desktop Test] Đã áp dụng Viewport 1280px:', res);
                    // Chờ 500ms để trình duyệt render lại CSS media queries rồi kiểm tra lại
                    setTimeout(() => {
                        this.update();
                    }, 500);
                };
            }

            const btnCheck = document.getElementById('kg-dt-btn-check');
            if (btnCheck) {
                btnCheck.onclick = () => {
                    this.update();
                };
            }

            const btnRestore = document.getElementById('kg-dt-btn-restore');
            if (btnRestore) {
                btnRestore.onclick = () => {
                    ViewportManager.restoreOriginal();
                    console.log('[KageVietSub Desktop Test] Đã khôi phục Viewport ban đầu');
                    setTimeout(() => {
                        this.update();
                    }, 500);
                };
            }
        }
    };

    // =========================================================================
    // 5. KHỞI CHẠY TỰ ĐỘNG
    // =========================================================================
    function init() {
        console.log('%c[KAGEVIETSUB Desktop Test] Khởi tạo công cụ chẩn đoán Desktop Mode v1.0.0...', 'color: #00d2ff; font-weight: bold;');
        ViewportManager.init();

        const dev = DeviceDetector.detect();
        console.log(`[KageVietSub Desktop Test] Thiết bị: ${dev.deviceType} (${dev.viewportWidth}x${dev.viewportHeight})`);

        // Nếu phát hiện là MOBILE, có thể ghi nhận trạng thái
        if (dev.deviceType === 'MOBILE') {
            console.log('[KageVietSub Desktop Test] Phát hiện điện thoại di động. Sẵn sàng thử nghiệm chuyển đổi viewport.');
        } else {
            console.log('[KageVietSub Desktop Test] Đang sử dụng máy tính (Desktop). Giữ nguyên không tự động thay đổi viewport.');
        }

        // Hiển thị giao diện kiểm tra
        UIController.render();

        // Lắng nghe thay đổi kích thước cửa sổ để tự động cập nhật số liệu
        window.addEventListener('resize', () => {
            if (UIController.container && UIController.container.style.display !== 'none') {
                UIController.update();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
