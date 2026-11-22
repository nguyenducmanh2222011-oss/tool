
// ==UserScript==
// @name         KAGEVIETSUB - DeepSeek Tool Disabled
// @namespace    https://kagevietsub.com/
// @version      1.0
// @description  Display tool disabled notification on DeepSeek
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function showNotice() {
        if (document.getElementById('kage-disabled-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'kage-disabled-overlay';

        overlay.innerHTML = `
            <div class="kage-notice">
                <div class="kage-icon">!</div>
                <div class="kage-title">THÔNG BÁO HỆ THỐNG</div>
                <div class="kage-line"></div>
                <div class="kage-message">
                    TOOL KHÔNG CÒN<br>
                    KHẢ NĂNG SỬ DỤNG
                </div>
                <div class="kage-description">
                    Chức năng kết nối DeepSeek đã ngừng hoạt động.
                    Vui lòng không tiếp tục sử dụng công cụ này.
                </div>
                <div class="kage-footer">KAGEVIETSUB SYSTEM</div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #kage-disabled-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                justify-content: center;
                align-items: center;
                background: rgba(0, 0, 0, 0.82);
                backdrop-filter: blur(9px);
                font-family: Arial, sans-serif;
            }

            .kage-notice {
                width: min(440px, calc(100vw - 40px));
                padding: 38px 30px;
                box-sizing: border-box;
                text-align: center;
                color: white;
                background: #101722;
                border: 1px solid #34495e;
                border-top: 3px solid #ef4444;
                border-radius: 14px;
                box-shadow: 0 20px 80px #000a;
                animation: kageAppear .35s ease;
            }

            .kage-icon {
                width: 58px;
                height: 58px;
                line-height: 58px;
                margin: 0 auto 20px;
                border-radius: 50%;
                color: #fff;
                background: #dc2626;
                font-size: 36px;
                font-weight: bold;
            }

            .kage-title {
                color: #94a3b8;
                font-size: 13px;
                letter-spacing: 3px;
                font-weight: bold;
            }

            .kage-line {
                width: 55px;
                height: 2px;
                background: #ef4444;
                margin: 22px auto;
            }

            .kage-message {
                color: #ff5555;
                font-size: 23px;
                font-weight: 800;
                line-height: 1.5;
                letter-spacing: 1px;
            }

            .kage-description {
                margin-top: 20px;
                color: #cbd5e1;
                font-size: 14px;
                line-height: 1.7;
            }

            .kage-footer {
                margin-top: 30px;
                color: #64748b;
                font-size: 10px;
                letter-spacing: 3px;
            }

            @keyframes kageAppear {
                from { opacity: 0; transform: translateY(15px) scale(.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(overlay);
    }

    showNotice();

    // Giữ thông báo khi DeepSeek chuyển trang nội bộ
    const observer = new MutationObserver(showNotice);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

})();
