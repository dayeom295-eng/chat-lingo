const MODULE_ID = 'chatlingo';
const PANEL_ID = 'chatlingo-panel';
// No arbitrary word-count ceiling. The practical limit is the browser storage
// available to SillyTavern on the current device.
const MAX_SAVED_WORDS = Number.POSITIVE_INFINITY;
const WORDBOOK_PAGE_SIZE = 20;
const WORDBOOK_ENRICH_BATCH_SIZE = 20;
const SETTINGS_VERSION = 6;
const DEFAULT_MAX_TOKENS = 6000;
const MIN_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 16384;

const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    language: 'ja',
    connectionProfileId: '',
    contextMessageCount: 0,
    latestImportMode: 'dialogue',
    maxTokens: DEFAULT_MAX_TOKENS,
    ttsSource: 'browser',
    ttsRate: 0.9,
    ttsPitch: 1,
    ttsVolume: 1,
    ttsVoiceJa: '',
    ttsVoiceEn: '',
    savedWords: [],
};

let settings;
let activeController = null;
let analysisStartedAt = 0;
let lastAnalysis = null;
let profileService = null;
let voices = [];
let lastSelectedChatText = '';
let activeSpeech = null;
let ttsIntegrationMonitor = null;
let editingSavedWordIndex = null;
const wordbookView = { language: 'all', sort: 'newest', page: 1 };

function getContext() {
    if (!globalThis.SillyTavern?.getContext) {
        throw new Error('SillyTavern 컨텍스트를 찾을 수 없습니다.');
    }
    return globalThis.SillyTavern.getContext();
}

function escapeHtml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[MODULE_ID] = settings;
    context.saveSettingsDebounced();
}

function toast(type, message) {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, '챗링고');
        return;
    }
    console[type === 'error' ? 'error' : 'log'](`[ChatLingo] ${message}`);
}

function icon(name) {
    const icons = {
        book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        play: '<path d="M11 5 6.5 9H3v6h3.5l4.5 4z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
        sparkle: '<path d="m12 4 1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/>',
        save: '<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-3.5L6 21V4a1 1 0 0 1 1-1z"/>',
        trash: '<path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
        copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
        download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/>',
        refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 8A7 7 0 0 1 18 6l2 6M17.9 16A7 7 0 0 1 6 18l-2-6"/>',
        chevron: '<path d="m7 9 5 5 5-5"/>',
        chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
        collapse: '<path d="M6 12h12"/>',
        expand: '<path d="m10 10-4-4m0 0h3M6 6v3M14 14l4 4m0 0h-3m3 0v-3"/>',
    };
    return `<svg class="chatlingo-svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.sparkle}</svg>`;
}

function panelMarkup() {
    return `
        <div id="${PANEL_ID}" class="chatlingo-panel" role="complementary" aria-label="챗링고 언어 학습 패널" aria-hidden="true">
            <header class="chatlingo-header">
                <div class="chatlingo-brand">
                    <span class="chatlingo-logo">Aあ</span>
                    <div><strong>챗링고</strong><small>대화가 곧 교재가 되는 단어장</small></div>
                </div>
                <div class="chatlingo-header-actions">
                    <button id="chatlingo-collapse" class="chatlingo-icon-btn" data-action="collapse" title="작게 접기" aria-label="작게 접기">${icon('collapse')}</button>
                    <button class="chatlingo-icon-btn" data-action="close" title="닫기" aria-label="닫기">${icon('close')}</button>
                </div>
            </header>

            <div class="chatlingo-tabs" role="tablist">
                <button class="chatlingo-tab" data-language="ja" role="tab">日本語 <small>일본어</small></button>
                <button class="chatlingo-tab" data-language="en" role="tab">English <small>영어</small></button>
            </div>

            <div class="chatlingo-scroll">
                <section class="chatlingo-input-card">
                    <div class="chatlingo-section-title"><span>학습할 문장</span><span id="chatlingo-count">0자</span></div>
                    <textarea id="chatlingo-input" rows="5" maxlength="8000" placeholder="채팅에서 배우고 싶은 문장이나 단어를 넣어보세요."></textarea>
                    <div class="chatlingo-source-actions">
                        <button data-action="selection">선택 문장 가져오기</button>
                        <button data-action="latest">${icon('chat')} 최근 AI 답변</button>
                        <button data-action="clear">비우기</button>
                    </div>
                    <div class="chatlingo-context-details">
                        <label for="chatlingo-context">서사 추가 <span>(선택)</span></label>
                        <p id="chatlingo-context-help">인물 간의 관계나 상황을 넣으면 더 입체적인 분석이 가능합니다.</p>
                        <textarea id="chatlingo-context" rows="3" maxlength="10000" placeholder="예: 두 사람은 사귄 지 얼마 안 된 사이이며, 아직 서로에게 조심스럽다."></textarea>
                    </div>
                    <button id="chatlingo-analyze" class="chatlingo-primary" data-action="analyze">${icon('sparkle')} 분석 시작</button>
                </section>

                <section id="chatlingo-status" class="chatlingo-status" hidden></section>
                <section id="chatlingo-result" class="chatlingo-result" aria-live="polite" hidden></section>

                <details class="chatlingo-book-section">
                    <summary>${icon('book')} 내 단어장 <span id="chatlingo-word-count">0</span> ${icon('chevron')}</summary>
                    <div class="chatlingo-wordbook-focus-bar"><strong>내 단어장</strong><div><button id="chatlingo-fill-missing-meanings" data-action="fill-missing-meanings" title="뜻이 비어 있는 단어만 현재 분석 연결로 보완합니다.">빈 뜻 자동 채우기</button><button data-action="merge-duplicates" title="같은 언어의 동일한 표기 단어를 하나로 합칩니다.">중복 단어 병합</button><button data-action="close-wordbook-focus">기본 보기</button></div></div>
                    <button class="chatlingo-wordbook-expand" data-action="focus-wordbook">단어장 크게 보기</button>
                    <div id="chatlingo-wordbook"></div>
                    <div class="chatlingo-wordbook-actions">
                        <button class="chatlingo-secondary" data-action="export-backup" title="다른 기기나 새 설치에서 단어장을 되살릴 수 있는 파일을 저장합니다.">백업 파일 저장</button>
                        <button class="chatlingo-secondary" data-action="import-wordbook" title="전에 저장한 챗링고 백업 파일에서 단어장을 복원합니다.">백업 불러오기</button>
                    </div>
                    <input id="chatlingo-import-file" type="file" accept=".csv,.json,text/csv,application/json" hidden>
                </details>

                <details class="chatlingo-settings">
                    <summary>분석 · 음성 설정 ${icon('chevron')}</summary>
                    <div class="chatlingo-setting-grid">
                        <label><span>분석 연결</span>
                            <select id="chatlingo-profile"><option value="">메인 API · 현재 모델</option></select>
                        </label>
                        <label><span>최대 출력 토큰</span>
                            <input id="chatlingo-max-tokens" type="number" min="${MIN_MAX_TOKENS}" max="${MAX_MAX_TOKENS}" step="500" inputmode="numeric" title="기본값 6,000. 긴 분석이 잘리면 늘려주세요.">
                        </label>
                        <label><span>자동 문맥 범위</span>
                            <select id="chatlingo-context-count">
                                <option value="0">사용 안 함</option>
                                <option value="2">최근 2개 메시지</option>
                                <option value="4">최근 4개 메시지</option>
                                <option value="6">최근 6개 메시지</option>
                            </select>
                        </label>
                        <label><span>최근 AI 답변 가져오기</span>
                            <select id="chatlingo-latest-mode">
                                <option value="dialogue">대사만 (따옴표 안)</option>
                                <option value="all">전체 (태그 제외)</option>
                            </select>
                        </label>
                        <label><span>일본어 목소리</span><select id="chatlingo-voice-ja"></select></label>
                        <label><span>영어 목소리</span><select id="chatlingo-voice-en"></select></label>
                        <label><span>읽기 속도 <output id="chatlingo-rate-value"></output></span>
                            <input id="chatlingo-rate" type="range" min="0.5" max="1.5" step="0.05">
                        </label>
                        <label><span>음성 연결</span>
                            <select id="chatlingo-tts-source">
                                <option value="browser">기기 기본 음성 (무료)</option>
                                <option value="sillytavern">실리태번 TTS · 캐릭터 음성</option>
                            </select>
                        </label>
                    </div>
                    <p id="chatlingo-voice-status" class="chatlingo-hint">이 기기와 브라우저에서 사용 가능한 음성을 확인하고 있어요.</p>
                    <p id="chatlingo-tts-source-help" class="chatlingo-hint">기본 음성은 기기·운영체제·브라우저에 따라 종류와 품질이 다를 수 있어요.</p>
                </details>
            </div>
        </div>`;
}

function launcherMarkup() {
    return `<a id="chatlingo-menu-item" class="chatlingo-menu-entry interactable" tabindex="0">
        <span class="chatlingo-menu-logo">Aあ</span><span>챗링고</span>
    </a>`;
}

function installHamburgerMenuItem() {
    if (document.getElementById('chatlingo-menu-item')) return true;
    const host = document.querySelector('#options .options-content');
    if (!host) return false;
    const divider = host.querySelector('hr');
    if (divider) divider.insertAdjacentHTML('beforebegin', launcherMarkup());
    else host.insertAdjacentHTML('afterbegin', launcherMarkup());
    const item = document.getElementById('chatlingo-menu-item');
    item?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
    });
    item?.addEventListener('touchend', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel();
    }, { passive: false });
    return true;
}

function updateFallbackLauncher() {
    const fallback = document.getElementById('chatlingo-fallback-launcher');
    if (!fallback) return;
    const menuInstalled = Boolean(document.getElementById('chatlingo-menu-item'));
    const panelOpen = document.getElementById(PANEL_ID)?.classList.contains('is-open');
    fallback.hidden = menuInstalled || panelOpen;
}

function openPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) document.documentElement.append(panel);
    panel?.removeAttribute('hidden');
    setPanelCollapsed(false);
    panel?.classList.add('is-open');
    panel?.setAttribute('aria-hidden', 'false');
    updateFallbackLauncher();
    applyResponsivePanelLayout();
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(() => schedule(ensurePanelOnScreen));
    if ((globalThis.visualViewport?.width || globalThis.innerWidth) > 1024) {
        setTimeout(() => document.getElementById('chatlingo-input')?.focus(), 180);
    }
}

function applyResponsivePanelLayout() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel?.classList.contains('is-open')) return;
    const viewport = globalThis.visualViewport;
    const width = Math.round(viewport?.width || globalThis.innerWidth || document.documentElement.clientWidth);
    const height = Math.round(viewport?.height || globalThis.innerHeight || document.documentElement.clientHeight);
    const collapsed = panel.classList.contains('is-collapsed');
    const wordbookFocus = panel.classList.contains('is-wordbook-focus');
    const set = (property, value) => panel.style.setProperty(property, value, 'important');
    let panelWidth;
    let panelHeight;

    if (wordbookFocus) {
        // Keep the enlarged view entirely inside even short phone viewports.
        panelWidth = Math.min(760, Math.max(220, width - 24));
        panelHeight = Math.min(780, Math.max(240, height - 24));
    } else if (width <= 600) {
        panelWidth = Math.min(268, Math.max(228, width - 76));
        panelHeight = Math.min(590, Math.max(400, height * 0.70), height - 24);
    } else if (width <= 1024) {
        panelWidth = Math.min(312, width - 104);
        panelHeight = Math.min(690, Math.max(460, height * 0.76), height - 24);
    } else {
        panelWidth = Math.min(340, width - 32);
        panelHeight = Math.min(720, Math.max(520, height * 0.80), height - 24);
    }
    const renderedHeight = collapsed ? 42 : Math.max(240, panelHeight);
    const top = Math.max(12, Math.round((height - renderedHeight) / 2));

    set('display', 'flex');
    set('position', 'fixed');
    set('z-index', '2147483646');
    set('visibility', 'visible');
    set('opacity', '1');
    set('pointer-events', 'auto');
    set('transform', 'translate3d(0, 0, 0)');
    set('top', `${top}px`);
    set('right', wordbookFocus ? 'auto' : '12px');
    set('left', wordbookFocus ? `${Math.max(12, Math.round((width - panelWidth) / 2))}px` : 'auto');
    set('bottom', 'auto');
    set('width', collapsed ? '148px' : `${panelWidth}px`);
    set('height', collapsed ? 'auto' : `${renderedHeight}px`);
    set('max-width', 'calc(100vw - 24px)');
    set('max-height', collapsed ? 'none' : `${renderedHeight}px`);
}

function ensurePanelOnScreen() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel?.classList.contains('is-open')) return;
    const viewportWidth = Math.round(globalThis.visualViewport?.width || document.documentElement.clientWidth || globalThis.innerWidth);
    const viewportHeight = Math.round(globalThis.visualViewport?.height || document.documentElement.clientHeight || globalThis.innerHeight);
    const rect = panel.getBoundingClientRect();
    const outside = rect.top < 0 || rect.top > viewportHeight - 40 || rect.left < 0 || rect.right > viewportWidth + 1;
    if (outside) {
        const safeHeight = Math.max(240, Math.min(680, viewportHeight - 24));
        panel.style.setProperty('top', `${Math.max(12, Math.round((viewportHeight - safeHeight) / 2))}px`, 'important');
        panel.style.setProperty('right', '12px', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('left', 'auto', 'important');
        panel.style.setProperty('width', `${Math.max(220, Math.min(340, viewportWidth - 24))}px`, 'important');
        panel.style.setProperty('height', `${safeHeight}px`, 'important');
        panel.style.setProperty('max-height', `${safeHeight}px`, 'important');
        panel.style.setProperty('transform', 'none', 'important');
    }
}

function setPanelCollapsed(collapsed) {
    const panel = document.getElementById(PANEL_ID);
    const button = document.getElementById('chatlingo-collapse');
    if (collapsed) panel?.classList.remove('is-wordbook-focus');
    panel?.classList.toggle('is-collapsed', collapsed);
    if (button) {
        button.innerHTML = icon(collapsed ? 'expand' : 'collapse');
        button.title = collapsed ? '펼치기' : '작게 접기';
        button.setAttribute('aria-label', button.title);
    }
    applyResponsivePanelLayout();
}

function togglePanelCollapsed() {
    const panel = document.getElementById(PANEL_ID);
    setPanelCollapsed(!panel?.classList.contains('is-collapsed'));
}

function setWordbookFocus(focused) {
    const panel = document.getElementById(PANEL_ID);
    const section = panel?.querySelector('.chatlingo-book-section');
    if (!panel) return;
    panel.classList.toggle('is-wordbook-focus', focused);
    if (focused) {
        section.open = true;
        setPanelCollapsed(false);
    }
    applyResponsivePanelLayout();
}

function closePanel() {
    stopSpeech();
    const panel = document.getElementById(PANEL_ID);
    panel?.classList.remove('is-open');
    panel?.classList.remove('is-wordbook-focus');
    panel?.setAttribute('aria-hidden', 'true');
    updateFallbackLauncher();
    if (panel) {
        panel.style.setProperty('opacity', '0', 'important');
        panel.style.setProperty('visibility', 'hidden', 'important');
        panel.style.setProperty('pointer-events', 'none', 'important');
        panel.style.setProperty('transform', 'translate3d(calc(100% + 28px), 0, 0)', 'important');
        setTimeout(() => {
            if (!panel.classList.contains('is-open')) panel.removeAttribute('style');
        }, 220);
    }
}

function inferWordLanguage(surface, fallback = 'ja') {
    const value = stripAnnotations(surface || '').normalize('NFKC');
    if (/[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/.test(value)) return 'ja';
    if (/[A-Za-z]/.test(value)) return 'en';
    return fallback === 'en' ? 'en' : 'ja';
}

function repairSavedWordLanguages() {
    let changed = false;
    for (const item of settings.savedWords || []) {
        const language = inferWordLanguage(item.surface, item.language);
        if (item.language !== language) {
            item.language = language;
            changed = true;
        }
        const key = `${language}:${item.surface}:${item.meaning || ''}`;
        if (item.key !== key) {
            item.key = key;
            changed = true;
        }
    }
    return changed;
}

function setLanguage(language) {
    settings.language = language === 'en' ? 'en' : 'ja';
    repairSavedWordLanguages();
    wordbookView.language = settings.language;
    document.querySelectorAll('.chatlingo-tab').forEach((button) => {
        const selected = button.dataset.language === settings.language;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    const input = document.getElementById('chatlingo-input');
    if (input) input.placeholder = settings.language === 'ja'
        ? '예: 今日は本当に楽しかった。また一緒に行こう。'
        : 'e.g. I didn’t mean to put you on the spot.';
    renderWordbook();
    saveSettings();
}

function updateCount() {
    const length = document.getElementById('chatlingo-input')?.value.length || 0;
    const counter = document.getElementById('chatlingo-count');
    if (counter) counter.textContent = `${length.toLocaleString()}자`;
}

function selectedPageText() {
    const selection = globalThis.getSelection?.() || document.getSelection?.();
    return String(selection || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function rememberSelection() {
    const text = selectedPageText();
    if (text) lastSelectedChatText = text;
}

function copySelection() {
    // On mobile, tapping the fixed panel can clear Selection before its click event.
    const text = selectedPageText() || lastSelectedChatText;
    if (!text) {
        toast('info', '먼저 채팅에서 학습할 문장을 드래그해 선택해 주세요.');
        return;
    }
    const languageText = filterTextByLanguage(stripEmbeddedMetadata(text), settings.language);
    if (!languageText) {
        toast('info', `선택한 범위에서 ${settings.language === 'ja' ? '일본어' : '영어'} 문장을 찾지 못했습니다.`);
        return;
    }
    document.getElementById('chatlingo-input').value = languageText.slice(0, 8000);
    updateCount();
    toast('success', `선택한 범위에서 ${settings.language === 'ja' ? '일본어' : '영어'} 문장만 가져왔습니다.`);
}

function latestAssistantMessage() {
    const chat = getContext().chat || [];
    return [...chat].reverse().find((message) => !message.is_user && !message.is_system && message.mes)?.mes || '';
}

function hasTargetLanguage(text, language) {
    return language === 'ja'
        ? /[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/.test(text)
        : /[A-Za-z]{2,}/.test(text);
}

function splitLanguageUnits(line) {
    const units = [];
    let current = '';
    const source = String(line || '');
    const closingMarks = /[」』”"'’）)\]]/;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        current += character;
        const isJapaneseEnd = /[。！？]/.test(character);
        const isLatinEnd = /[.!?]/.test(character) && (!source[index + 1] || /\s/.test(source[index + 1]) || closingMarks.test(source[index + 1]));
        if (!isJapaneseEnd && !isLatinEnd) continue;
        while (source[index + 1] && closingMarks.test(source[index + 1])) current += source[++index];
        if (current.trim()) units.push(current.trim());
        current = '';
    }
    if (current.trim()) units.push(current.trim());
    return units;
}

function isTargetLanguageUnit(unit, language) {
    const text = String(unit || '');
    const japaneseCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/g) || []).length;
    const englishWords = text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
    const englishCount = englishWords.join('').length;
    if (language === 'ja') return japaneseCount > 0;
    if (!englishWords.some((word) => word.length >= 2)) return false;
    // 'AIを使う'처럼 짧은 영문 표기가 들어간 일본어 문장을 영어로 오인하지 않는다.
    if (japaneseCount > 0 && englishCount < Math.max(6, japaneseCount * 2)) return false;
    return true;
}

function cleanTargetLanguageUnit(unit, language) {
    let text = String(unit || '').trim();
    const nonTargetInBrackets = language === 'ja'
        ? /[（(\[［][^）)\]］]*[가-힣][^）)\]］]*[）)\]］]/g
        : /[（(\[［][^）)\]］]*[가-힣\u3040-\u30ff\u3400-\u9fff][^）)\]］]*[）)\]］]/g;
    text = text.replace(nonTargetInBrackets, '').trim();
    if (language === 'ja') {
        text = text.replace(/^[가-힣][가-힣\s·_-]{0,30}[:：]\s*/, '');
    } else {
        text = text.replace(/^[가-힣\u3040-\u30ff\u3400-\u9fff][가-힣\u3040-\u30ff\u3400-\u9fff\s·_-]{0,30}[:：]\s*/, '');
    }
    return text.trim();
}

function filterTextByLanguage(text, language) {
    const paragraphs = String(text || '').split(/\n/);
    const filtered = paragraphs.map((line) => splitLanguageUnits(line)
        .filter((unit) => isTargetLanguageUnit(unit, language))
        .map((unit) => cleanTargetLanguageUnit(unit, language))
        .filter(Boolean)
        .join(' '))
        .filter(Boolean);
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function uniqueText(items) {
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function stripEmbeddedMetadata(message) {
    let text = String(message || '').replace(/\r\n?/g, '\n');
    const metadataBlock = /<(status|state|system|metadata|meta|ooc|scene|narration|thought|thinking|analysis|memory|lore|author_note|summary|settings|hidden)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    while (metadataBlock.test(text)) {
        text = text.replace(metadataBlock, '');
        metadataBlock.lastIndex = 0;
    }
    text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text;
}

function cleanLatestAssistantMessage(message, language, mode = settings.latestImportMode) {
    const text = stripEmbeddedMetadata(message);
    if (mode === 'all') return filterTextByLanguage(text, language);

    const quoted = uniqueText([...text.matchAll(/[「『“"]([^「」『』“”"\n]+)[」』”"]/g)]
        .filter((match) => hasTargetLanguage(match[1], language))
        .map((match) => match[0]));
    if (quoted.length) return filterTextByLanguage(quoted.join('\n'), language);

    // 대사 모드라도 따옴표가 전혀 없으면 해당 언어가 포함된 일반 문장을 가져온다.
    return filterTextByLanguage(text, language);
}

function copyLatest() {
    const latest = latestAssistantMessage();
    if (!latest) {
        toast('info', '가져올 AI 답변이 없습니다.');
        return;
    }
    const languageText = cleanLatestAssistantMessage(latest, settings.language);
    if (!languageText) {
        toast('info', '최근 AI 답변에서 가져올 학습 문장을 찾지 못했습니다.');
        return;
    }
    document.getElementById('chatlingo-input').value = languageText.slice(0, 8000);
    updateCount();
    toast('success', settings.latestImportMode === 'dialogue'
        ? '대사를 가져왔습니다. 따옴표가 없으면 일반 문장을 대신 가져와요.'
        : `상태 태그를 제외하고 ${settings.language === 'ja' ? '일본어' : '영어'} 문장만 가져왔습니다.`);
}

function recentContext(targetText = '') {
    const chat = getContext().chat || [];
    const count = [0, 2, 4, 6].includes(Number(settings.contextMessageCount)) ? Number(settings.contextMessageCount) : 0;
    if (count === 0) return '';
    const normalizedTarget = String(targetText).replace(/\s+/g, ' ').trim();
    return chat.map((message) => {
        const speaker = message.is_user ? '사용자' : '상대';
        const plain = stripEmbeddedMetadata(message.mes);
        return { speaker, plain, normalized: plain.replace(/\s+/g, ' ').trim() };
    }).filter((item) => {
        if (!item.normalized || normalizedTarget.length < 20) return Boolean(item.normalized);
        return !item.normalized.includes(normalizedTarget) && !normalizedTarget.includes(item.normalized);
    }).slice(-count).map((item) => `${item.speaker}: ${item.plain}`).join('\n').slice(0, 10000);
}

function participantNameContext() {
    try {
        const context = getContext();
        const cleanName = (value) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
        const userName = cleanName(context.name1 || context.userName || context.user_name || '');
        const characterName = cleanName(
            context.name2
            || context.characterName
            || context.characters?.[context.characterId]?.name
            || '',
        );
        const lines = [
            userName ? `사용자 이름: ${userName}` : '',
            characterName ? `캐릭터 이름: ${characterName}` : '',
        ].filter(Boolean);
        return lines.length ? `[참여자 이름 — 이름 외 프로필 정보는 사용하지 않음]\n${lines.join('\n')}` : '';
    } catch {
        return '';
    }
}

function updateContextHelp() {
    const helper = document.getElementById('chatlingo-context-help');
    if (!helper) return;
    helper.textContent = '인물 간의 관계나 상황을 넣으면 더 입체적인 분석이 가능합니다.';
}

function buildSectionPrompt(text, contextText) {
    const isJapanese = settings.language === 'ja';
    const fullTarget = String(text || '').replace(/\r\n?/g, '\n').trim();
    const languageRules = isJapanese
        ? `ANNOTATED에는 전체 일본어 원문을 한 글자도 생략하지 않고 보존한다.
ANNOTATED의 모든 한자와 모든 가타카나는 반드시 {今日}[きょう], {スマートフォン}[すまーとふぉん] 형식으로 읽기를 붙인다. 읽기 없는 한자·가타카나를 남기지 않는다.
PRONUNCIATION과 VOCABULARY의 KOREAN_PRONUNCIATION은 한국인이 읽을 수 있는 한글 발음으로 쓴다. PRONUNCIATION은 원문과 줄 수를 똑같이 유지하고 호칭·이름·부사·조사·중간 구절을 하나도 생략하지 않는다.
VOCABULARY의 두 번째 필드 읽기는 히라가나, 세 번째 필드 한글 발음은 한글로 쓴다.
TRANSLATION, CONTEXT_NOTE, 문법 설명, 단어 뜻·뉘앙스·예문 번역은 반드시 자연스러운 한국어로 쓴다. 원문의 일본어 외에 뜻이나 설명을 중국어·한문으로 쓰지 않는다.`
        : `ANNOTATED에는 전체 영어 원문을 그대로 쓴다.
PRONUNCIATION과 KOREAN_PRONUNCIATION은 문장 속 실제 영어 발음을 반드시 한글로 쓴다. 영어 철자·로마자·IPA만 적거나 빈칸으로 두지 않는다. 예: What are you doing? → 왓 아 유 두잉?
PRONUNCIATION은 원문과 줄 수를 똑같이 유지하고 호칭·이름·부사·조사·중간 구절을 하나도 생략하지 않는다. VOCABULARY의 모든 영어 표현에도 KOREAN_PRONUNCIATION을 빠짐없이 쓴다.
TRANSLATION, CONTEXT_NOTE, 문법 설명, 단어 뜻·뉘앙스·예문 번역은 반드시 자연스러운 한국어로 쓴다.`;

    return `당신은 한국인 학습자를 돕는 ${isJapanese ? '일본어' : '영어'} 교사다.
아래 학습 대상 전체를 문맥에 맞게 분석하라. 첫 문장만 분석하거나 원문을 생략하지 않는다.
등장인물과 사용자의 이름·성·별명·호칭은 단어 목록에서 제외한다.
${languageRules}

JSON을 사용하지 말고 반드시 다음 구분 표시를 그대로 사용한다.
각 단어 항목은 한 줄이며 필드 사이는 정확히 ||| 로 구분한다.

[[ANNOTATED]]
읽기 표시가 적용된 전체 원문
[[PRONUNCIATION]]
전체 문장의 한국어 발음
[[TRANSLATION]]
자연스러운 전체 한국어 번역
[[CONTEXT_NOTE]]
문맥에서의 말투와 핵심 의미
[[GRAMMAR]]
표현 ||| 한국어 설명
[[VOCABULARY]]
원문 표현 ||| 읽기 ||| 한글 발음 ||| 품사 ||| 문맥상 뜻 ||| 뉘앙스 ||| 새 예문 ||| 예문 번역
[[END]]

GRAMMAR는 최대 6개, VOCABULARY는 학습 가치가 높은 항목을 1개 이상 최대 12개 쓴다. 다른 설명이나 머리말을 덧붙이지 않는다.
출력 직전에 다음을 스스로 확인한다: ① ANNOTATED를 읽기 표시만 제거하면 학습 대상과 글자·문장 수가 같다. ② 일본어 한자와 가타카나에 읽기 표시가 빠짐없이 있다. ③ 발음·번역·설명·단어 뜻은 한국어다. ④ 모든 구분 표시와 VOCABULARY가 있다.

[대화 문맥]
${contextText || '(별도 문맥 없음)'}

[학습 대상 전체]
${fullTarget}`;
}

function buildStrictRetryPrompt(text, contextText, failureReason = '', failedResponse = '') {
    const vocabularyReadingLabel = settings.language === 'ja' ? '히라가나 읽기' : '읽기(영어는 빈칸)';
    return `이전 응답은 필수 규칙을 통과하지 못했다.
실패한 이유: ${failureReason || '원문 보존·후리가나·한국어 번역·한국어 발음 중 하나가 누락됨'}
이 요청은 역할극이나 창작이 아니라 원문을 보존하는 언어 학습 데이터 변환이다.
아래의 짧은 복구 형식만 출력한다. JSON, 코드블록, 표, 머리말은 절대 쓰지 않는다.
[[PRONUNCIATION]]
학습 대상 전체를 한국인이 읽을 수 있게 적은 한글 발음. 원문과 줄 수를 똑같이 맞추고 호칭·이름·부사·조사·문장 중간 구절을 하나도 생략하지 않는다.
[[TRANSLATION]]
학습 대상 전체의 자연스러운 한국어 번역
[[CONTEXT_NOTE]]
한국어로 쓴 문맥상 의미와 말투
[[READINGS]]
일본어일 때만 한자·가타카나 표현 ||| 히라가나 읽기 (한 줄에 하나)
[[VOCABULARY]]
원문 표현 ||| ${vocabularyReadingLabel} ||| 한글 발음 ||| 품사 ||| 한국어 뜻 ||| 한국어 뉘앙스 ||| 새 예문 ||| 한국어 예문 번역
[[END]]

설명에 일본어나 중국어를 대신 쓰지 않는다. PRONUNCIATION과 TRANSLATION에는 반드시 한글이 들어가야 한다. 영어 발음에는 영어 철자·로마자·IPA만 적지 않는다. 발음은 요약이 아니므로 원문의 모든 말을 처음부터 끝까지 순서대로 적는다.

[문맥]
${contextText || '(별도 문맥 없음)'}

[학습 대상 전체]
${String(text || '').replace(/\r\n?/g, '\n').trim()}`;
}

function inspectJsonStructure(value) {
    const stack = [];
    let inString = false;
    let escaped = false;
    let mismatched = false;
    for (const character of value) {
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
            const expected = character === '}' ? '{' : '[';
            if (stack.pop() !== expected) mismatched = true;
        }
    }
    return { inString, stack, mismatched };
}

function looksLikeAnalysisPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const analysisKeys = new Set([
        'annotated', 'annotated_text', 'translation', 'korean_translation', 'pronunciation',
        'korean_pronunciation', 'grammar', 'grammar_points', 'vocabulary', 'words', 'key_expressions', 'key_words',
        '원문', '번역', '한국어 번역', '발음', '한글 발음', '문법', '어휘', '단어',
    ].map(normalizedAnalysisKey));
    return Object.keys(value).some((key) => analysisKeys.has(normalizedAnalysisKey(key)));
}

function findAnalysisPayload(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
    if (looksLikeAnalysisPayload(value)) return value;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const found = findAnalysisPayload(child, depth + 1, seen);
        if (found) return found;
    }
    return null;
}

function responsePayloadToText(value, depth = 0, seen = new Set()) {
    if (typeof value === 'string') return value;
    if (value == null || depth > 8) return '';
    if (Array.isArray(value)) {
        const visibleItems = value.filter((item) => !item || typeof item !== 'object'
            || (item.type !== 'thinking' && item.type !== 'reasoning' && item.thought !== true));
        const sourceItems = visibleItems.length ? visibleItems : value;
        return sourceItems.map((item) => responsePayloadToText(item, depth + 1, seen)).filter(Boolean).join('\n');
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    const preferredKeys = [
        'original', 'text', 'output_text', 'completion', 'generated_text',
        'content', 'response', 'message', 'result', 'data', 'choices',
        'candidates', 'parts', 'results', 'output', 'value', 'parsed',
        'reasoning_content', 'reasoning', 'thinking',
    ];
    for (const key of preferredKeys) {
        if (!Object.hasOwn(value, key)) continue;
        const text = responsePayloadToText(value[key], depth + 1, seen);
        if (text) return text;
    }
    return '';
}

function responseIndicatesTruncation(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        if (/^(?:finish_reason|stop_reason|reason|status)$/i.test(key)
            && /^(?:length|max_tokens|max_output_tokens|incomplete)$/i.test(String(child || ''))) return true;
        if (responseIndicatesTruncation(child, depth + 1, seen)) return true;
    }
    return false;
}

function parseSectionedAnalysis(value) {
    const raw = (typeof value === 'object' && value !== null ? responsePayloadToText(value) : String(value || '')).trim();
    const headingAliases = new Map([
        ['ANNOTATED', 'ANNOTATED'], ['원문', 'ANNOTATED'], ['전체 원문', 'ANNOTATED'],
        ['PRONUNCIATION', 'PRONUNCIATION'], ['발음', 'PRONUNCIATION'], ['한글 발음', 'PRONUNCIATION'],
        ['TRANSLATION', 'TRANSLATION'], ['번역', 'TRANSLATION'], ['한국어 번역', 'TRANSLATION'],
        ['CONTEXT_NOTE', 'CONTEXT_NOTE'], ['문맥', 'CONTEXT_NOTE'], ['문맥 설명', 'CONTEXT_NOTE'], ['문맥 포인트', 'CONTEXT_NOTE'],
        ['GRAMMAR', 'GRAMMAR'], ['문법', 'GRAMMAR'], ['표현 문법', 'GRAMMAR'],
        ['VOCABULARY', 'VOCABULARY'], ['단어', 'VOCABULARY'], ['어휘', 'VOCABULARY'], ['핵심 단어', 'VOCABULARY'], ['핵심 단어 표현', 'VOCABULARY'],
        ['KEY EXPRESSIONS', 'VOCABULARY'], ['KEY_EXPRESSIONS', 'VOCABULARY'], ['KEY WORDS', 'VOCABULARY'], ['KEY_WORDS', 'VOCABULARY'],
        ['핵심 표현', 'VOCABULARY'], ['주요 표현', 'VOCABULARY'], ['중요 단어', 'VOCABULARY'],
        ['READINGS', 'READINGS'], ['READING', 'READINGS'], ['읽기', 'READINGS'], ['후리가나', 'READINGS'],
        ['END', 'END'], ['끝', 'END'],
    ]);
    const normalizedRaw = raw.split(/\r?\n/).flatMap((line) => {
        const cleaned = line.trim()
            .replace(/^#{1,6}\s*/, '')
            .replace(/^\*\*(.*?)\*\*$/, '$1')
            .replace(/^\[+|\]+$/g, '')
            .replace(/^【|】$/g, '')
            .trim();
        for (const [alias, key] of headingAliases) {
            if (cleaned.toLocaleUpperCase() === alias.toLocaleUpperCase()) return [`[[${key}]]`];
            const prefix = `${alias}:`;
            if (cleaned.toLocaleUpperCase().startsWith(prefix.toLocaleUpperCase())) {
                return [`[[${key}]]`, cleaned.slice(prefix.length).trim()];
            }
        }
        return [line];
    }).join('\n');
    if (!/\[\[(?:ANNOTATED|PRONUNCIATION|TRANSLATION|CONTEXT_NOTE|GRAMMAR|VOCABULARY|READINGS)\]\]/i.test(normalizedRaw)) return null;
    const readSection = (name) => normalizedRaw.match(new RegExp(`\\[\\[${name}\\]\\]\\s*([\\s\\S]*?)(?=\\n?\\[\\[[A-Z_]+\\]\\]|$)`, 'i'))?.[1]?.trim() || '';
    const parseRows = (section, fieldCount) => section.split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
        .filter(Boolean)
        .map((line) => {
            if (/^\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line)) return null;
            const fields = line.includes('|||')
                ? line.split(/\s*\|\|\|\s*/)
                : (line.startsWith('|') && line.endsWith('|')
                    ? line.slice(1, -1).split(/\s*\|\s*/)
                    : [line]);
            while (fields.length < fieldCount) fields.push('');
            return fields.map((field) => field.trim());
        })
        .filter(Boolean);
    const grammar = parseRows(readSection('GRAMMAR'), 2)
        .filter(([pattern]) => !/^(?:표현|문법|pattern)$/i.test(pattern))
        .map(([pattern, explanation]) => ({ pattern, explanation }));
    const vocabulary = parseRows(readSection('VOCABULARY'), 8).map(([
        surface, reading, korean_pronunciation, part_of_speech, meaning, nuance, example, example_translation,
    ]) => ({ surface, reading, korean_pronunciation, part_of_speech, meaning, nuance, example, example_translation }))
        .filter((item) => !/^(?:원문 표현|표현|단어|surface)$/i.test(item.surface));
    const readings = parseRows(readSection('READINGS'), 2)
        .filter(([surface, reading]) => surface && reading)
        .map(([surface, reading]) => ({ surface, reading }));
    return {
        language: settings.language,
        annotated: readSection('ANNOTATED'),
        pronunciation: readSection('PRONUNCIATION'),
        translation: readSection('TRANSLATION'),
        context_note: readSection('CONTEXT_NOTE'),
        grammar,
        vocabulary: [...vocabulary, ...readings],
    };
}

function cleanLooseFieldValue(value) {
    let cleaned = String(value || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .replace(/^\s*,+\s*/, '')
        .replace(/\s*,+\s*$/, '')
        .trim();
    cleaned = cleaned.replace(/^("(?:\\.|[^"\\])*")\s*[}\]]*$/s, '$1');
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        const quote = cleaned[0];
        if (quote === '"') {
            try {
                return JSON.parse(cleaned);
            } catch {
                // 끊기거나 잘못 이스케이프된 문자열은 아래에서 바깥 따옴표만 제거한다.
            }
        }
        cleaned = cleaned.slice(1, -1);
    }
    return cleaned.replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
}

function extractLooseFields(value, aliases) {
    const raw = String(value || '');
    const aliasEntries = Object.entries(aliases)
        .flatMap(([key, names]) => names.map((name) => ({ key, name })))
        .sort((a, b) => b.name.length - a.name.length);
    const escapedNames = aliasEntries.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const keyPattern = new RegExp(`(?:^|[\\n\\r,{])\\s*["']?(${escapedNames.join('|')})["']?\\s*[:：]\\s*`, 'gimu');
    const markers = [];
    for (const match of raw.matchAll(keyPattern)) {
        const matchedName = match[1].toLocaleLowerCase();
        const entry = aliasEntries.find(({ name }) => name.toLocaleLowerCase() === matchedName);
        if (entry) markers.push({ key: entry.key, start: match.index, valueStart: match.index + match[0].length });
    }
    const fields = {};
    markers.forEach((marker, index) => {
        const end = markers[index + 1]?.start ?? raw.length;
        const cleaned = cleanLooseFieldValue(raw.slice(marker.valueStart, end));
        if (cleaned && !fields[marker.key]) fields[marker.key] = cleaned;
    });
    return fields;
}

function parseLooseObjectRows(value, type) {
    const raw = String(value || '');
    const fieldAliases = type === 'vocabulary' ? {
        surface: ['surface', 'word', 'term', '원문 표현', '표현', '단어'],
        reading: ['reading', 'furigana', '읽기'],
        korean_pronunciation: ['korean_pronunciation', 'korean pronunciation', '한글 발음'],
        part_of_speech: ['part_of_speech', 'part of speech', 'pos', '품사'],
        meaning: ['meaning', '뜻', '문맥상 뜻'],
        nuance: ['nuance', '뉘앙스'],
        example: ['example', '새 예문', '예문'],
        example_translation: ['example_translation', 'example translation', '예문 번역'],
    } : {
        pattern: ['pattern', 'expression', '표현', '문법'],
        explanation: ['explanation', '한국어 설명', '설명'],
    };
    const rows = [];
    for (const match of raw.matchAll(/\{([\s\S]*?)\}/g)) {
        const fields = extractLooseFields(match[1], fieldAliases);
        if (type === 'vocabulary' ? fields.surface : fields.pattern) rows.push(fields);
    }
    if (rows.length) return rows;

    return raw.split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
        .filter((line) => line.includes('|||'))
        .map((line) => line.split(/\s*\|\|\|\s*/).map((field) => cleanLooseFieldValue(field)))
        .map((fields) => type === 'vocabulary' ? {
            surface: fields[0] || '', reading: fields[1] || '', korean_pronunciation: fields[2] || '',
            part_of_speech: fields[3] || '', meaning: fields[4] || '', nuance: fields[5] || '',
            example: fields[6] || '', example_translation: fields[7] || '',
        } : { pattern: fields[0] || '', explanation: fields[1] || '' })
        .filter((item) => type === 'vocabulary' ? item.surface : item.pattern);
}

function parseLooseAnalysis(value) {
    const raw = typeof value === 'object' && value !== null ? responsePayloadToText(value) : String(value || '');
    const fields = extractLooseFields(raw, {
        annotated: ['annotated_text', 'annotated', 'furigana_text', '후리가나 원문', '전체 원문', '원문'],
        pronunciation: ['pronunciation', '한글 발음', '한국어 발음', '발음'],
        translation: ['korean_translation', 'translation', '한국어 번역', '번역'],
        context_note: ['context_note', 'context note', '문맥 포인트', '문맥 설명'],
        grammar: ['grammar', '표현 문법', '문법'],
        vocabulary: ['vocabulary', 'words', 'key_expressions', 'key expressions', 'key_words', 'key words', '핵심 단어 표현', '핵심 단어', '핵심 표현', '주요 표현', '중요 단어', '어휘'],
    });
    if (!fields.annotated && !fields.translation && !fields.pronunciation) return null;
    return {
        language: settings.language,
        annotated: fields.annotated || '',
        pronunciation: fields.pronunciation || '',
        translation: fields.translation || '',
        context_note: fields.context_note || '',
        grammar: parseLooseObjectRows(fields.grammar || '', 'grammar'),
        vocabulary: parseLooseObjectRows(fields.vocabulary || '', 'vocabulary'),
    };
}

function parseAnalysisPayload(value) {
    const sectioned = parseSectionedAnalysis(value);
    if (sectioned) return sectioned;
    try {
        return extractJson(value);
    } catch (error) {
        const loose = parseLooseAnalysis(value);
        if (loose) return loose;
        throw error;
    }
}

function mergeAnalysisPayloads(preferred, fallback) {
    const inputs = [preferred, fallback]
        .filter((item) => item && typeof item === 'object')
        .map(coerceAnalysisPayload);
    const firstText = (key, predicate = (value) => Boolean(value)) => {
        for (const item of inputs) {
            const value = String(item?.[key] || '').trim();
            if (predicate(value)) return value;
        }
        return '';
    };
    const combineRows = (key, identity) => {
        const seen = new Set();
        return inputs.flatMap((item) => Array.isArray(item?.[key]) ? item[key] : []).filter((row) => {
            const id = String(identity(row) || '').trim();
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    };
    return {
        language: settings.language,
        // 두 응답에서 얻은 읽기 표식을 모두 수집한 뒤 실제 표시는 원본 문장 위에 재구성한다.
        annotated: inputs.map((item) => String(item?.annotated || '')).filter(Boolean).join('\n'),
        pronunciation: firstText('pronunciation', (value) => /[가-힣]/.test(value)) || firstText('pronunciation'),
        translation: firstText('translation', (value) => /[가-힣]/.test(value)) || firstText('translation'),
        context_note: firstText('context_note'),
        grammar: combineRows('grammar', (row) => row?.pattern),
        vocabulary: combineRows('vocabulary', (row) => row?.surface),
    };
}

function salvageLabeledSection(raw, labelPattern) {
    const lines = String(raw || '').split(/\r?\n/);
    const anyHeading = /(?:annotated|pronunciation|translation|context|grammar|vocabulary|readings|원문|후리가나|발음|번역|해석|문맥|문법|단어|어휘)/i;
    for (let index = 0; index < lines.length; index++) {
        const cleaned = lines[index].trim()
            .replace(/^#{1,6}\s*/, '')
            .replace(/^\s*[-*•]\s*/, '')
            .replace(/^\*\*(.*?)\*\*$/, '$1')
            .replace(/^[\[【(（]+|[\]】)）]+$/g, '')
            .replace(/^\d+[.)]\s*/, '')
            .trim();
        if (!labelPattern.test(cleaned)) continue;
        const inline = cleaned.match(/[:：]\s*(.+)$/)?.[1]?.trim();
        if (inline && /[가-힣]/.test(inline)) return inline;
        const collected = [];
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            const next = lines[cursor].trim();
            if (!next) {
                if (collected.length) break;
                continue;
            }
            const headingLike = next.replace(/^#{1,6}\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/[\[\]*_]/g, '').trim();
            if (anyHeading.test(headingLike) && (headingLike.length < 45 || /^#{1,6}|^\[/.test(next))) break;
            collected.push(next.replace(/^\s*[-*•]\s*/, ''));
        }
        const value = collected.join('\n').trim();
        if (value) return value;
    }
    return '';
}

function salvageAnalysisResponses(...responses) {
    const raw = responses.map((value) => responsePayloadToText(value)).filter(Boolean).join('\n\n');
    if (!raw) return null;
    let translation = salvageLabeledSection(raw, /(?:한국어|한글|자연스러운)?\s*(?:번역|해석)|translation/i);
    const pronunciation = salvageLabeledSection(raw, /(?:한국어|한글)\s*발음|pronunciation/i);
    const contextNote = salvageLabeledSection(raw, /문맥(?:상\s*의미|\s*설명|\s*포인트)?|context(?:ual)?(?:\s*note|\s*meaning)?/i);

    if (!/[가-힣]/.test(translation)) {
        const koreanCandidates = raw.split(/\r?\n/)
            .map((line) => line.replace(/^\s*[-*•#]+\s*/, '').replace(/[*_`]/g, '').trim())
            .filter((line) => /[가-힣]/.test(line))
            .filter((line) => !/(?:죄송|요청을|형식을|규칙을|응답을|제공할 수|도와드릴 수)/.test(line))
            .sort((a, b) => (b.match(/[가-힣]/g)?.length || 0) - (a.match(/[가-힣]/g)?.length || 0));
        translation = koreanCandidates[0] || '';
    }

    const annotated = canonicalizeFurigana(raw);
    const vocabulary = [...annotated.matchAll(/\{([^{}\[\]]+)\}\[([^\]]+)\]/g)]
        .map((match) => ({ surface: match[1].trim(), reading: katakanaReadingToHiragana(match[2]).trim() }))
        .filter((item) => item.surface && /^[\u3040-\u309Fー・]+$/.test(item.reading));
    if (!translation && !pronunciation && !vocabulary.length) return null;
    return {
        language: settings.language,
        annotated,
        pronunciation,
        translation,
        context_note: contextNote,
        grammar: [],
        vocabulary,
    };
}

function katakanaReadingToHiragana(value) {
    return String(value || '').replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
}

function canonicalizeFurigana(value) {
    let text = String(value || '');
    text = text.replace(/<ruby[^>]*>\s*([^<]+?)\s*(?:<rp[^>]*>[\s\S]*?<\/rp>)?\s*<rt[^>]*>\s*([^<]+?)\s*<\/rt>\s*(?:<rp[^>]*>[\s\S]*?<\/rp>)?\s*<\/ruby>/gi,
        (_, base, reading) => `{${base.trim()}}[${katakanaReadingToHiragana(reading.trim())}]`);
    text = text.replace(/\{([^{}\[\]]+)\}\[([^\]]+)\]/g,
        (_, base, reading) => `{${base}}[${katakanaReadingToHiragana(reading)}]`);
    text = text.replace(/([\u3400-\u9FFF々〆ヵヶ\u30A1-\u30FA][\u3040-\u30FA\u3400-\u9FFF々〆ヵヶー]*)\[([\u3040-\u30FFー・\s]+)\]/g,
        (_, base, reading) => `{${base}}[${katakanaReadingToHiragana(reading.trim())}]`);
    text = text.replace(/([\u3400-\u9FFF々〆ヵヶ\u30A1-\u30FA][\u3040-\u30FA\u3400-\u9FFF々〆ヵヶー]*)[(（]([\u3040-\u30FFー・\s]+)[)）]/g,
        (_, base, reading) => `{${base}}[${katakanaReadingToHiragana(reading.trim())}]`);
    text = text.replace(/([\u3400-\u9FFF々〆ヵヶ\u30A1-\u30FA][\u3040-\u30FA\u3400-\u9FFF々〆ヵヶー]*)【([\u3040-\u30FFー・\s]+)】/g,
        (_, base, reading) => `{${base}}[${katakanaReadingToHiragana(reading.trim())}]`);
    text = text.replace(/([\u3400-\u9FFF々〆ヵヶ\u30A1-\u30FA][\u3040-\u30FA\u3400-\u9FFF々〆ヵヶー]*)\{([\u3040-\u30FFー・\s]+)\}/g,
        (_, base, reading) => `{${base}}[${katakanaReadingToHiragana(reading.trim())}]`);
    return text;
}

function replaceOutsideFurigana(value, replacer) {
    const source = String(value || '');
    const tokenPattern = /\{[^{}\[\]]+\}\[[^\]]+\]/g;
    let result = '';
    let lastIndex = 0;
    for (const match of source.matchAll(tokenPattern)) {
        result += replacer(source.slice(lastIndex, match.index));
        result += match[0];
        lastIndex = match.index + match[0].length;
    }
    return result + replacer(source.slice(lastIndex));
}

function completeJapaneseFurigana(value, vocabulary = []) {
    let text = canonicalizeFurigana(value);
    const readingEntries = vocabulary
        .map((item) => ({
            surface: stripAnnotations(item?.surface || '').trim(),
            reading: katakanaReadingToHiragana(item?.reading || '').replace(/\s+/g, ''),
        }))
        .filter(({ surface, reading }) => /[\u3400-\u9FFF々〆ヵヶ]/.test(surface) && /^[\u3040-\u309Fー・]+$/.test(reading))
        .sort((a, b) => b.surface.length - a.surface.length);

    for (const { surface, reading } of readingEntries) {
        text = replaceOutsideFurigana(text, (plain) => plain.split(surface).join(`{${surface}}[${reading}]`));
    }
    return replaceOutsideFurigana(text, (plain) => plain.replace(/[\u30A1-\u30FA\u30FC]+/g, (katakana) => {
        if (katakana === 'ー') return katakana;
        return `{${katakana}}[${katakanaReadingToHiragana(katakana)}]`;
    }));
}

function rebuildJapaneseAnnotated(targetText, suppliedAnnotated, vocabulary = []) {
    const readingMap = new Map();
    const canonical = canonicalizeFurigana(suppliedAnnotated);
    for (const match of canonical.matchAll(/\{([^{}\[\]]+)\}\[([^\]]+)\]/g)) {
        const surface = match[1].trim();
        const reading = katakanaReadingToHiragana(match[2]).replace(/\s+/g, '');
        if (surface && /^[\u3040-\u309Fー・]+$/.test(reading)) readingMap.set(surface, reading);
    }
    for (const item of vocabulary) {
        const surface = stripAnnotations(item?.surface || '').trim();
        const reading = katakanaReadingToHiragana(item?.reading || '').replace(/\s+/g, '');
        if (surface && /^[\u3040-\u309Fー・]+$/.test(reading)) readingMap.set(surface, reading);
    }

    let rebuilt = String(targetText || '');
    const entries = [...readingMap.entries()]
        .filter(([surface]) => rebuilt.includes(surface))
        .sort(([a], [b]) => b.length - a.length);
    for (const [surface, reading] of entries) {
        rebuilt = replaceOutsideFurigana(rebuilt, (plain) => plain.split(surface).join(`{${surface}}[${reading}]`));
    }
    return completeJapaneseFurigana(rebuilt, vocabulary);
}

function repairJsonCandidate(value) {
    const source = String(value || '').replace(/^\uFEFF/, '');
    let repaired = '';
    const stack = [];
    let inString = false;
    let escaped = false;
    const closerFor = (opener) => opener === '{' ? '}' : ']';

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (inString) {
            if (escaped) {
                repaired += character;
                escaped = false;
            } else if (character === '\\') {
                repaired += character;
                escaped = true;
            } else if (character === '"') {
                repaired += character;
                inString = false;
            } else if (character === '\n') {
                repaired += '\\n';
            } else if (character === '\r') {
                repaired += '\\r';
            } else if (character === '\t') {
                repaired += '\\t';
            } else {
                repaired += character;
            }
            continue;
        }

        if (character === '"') {
            repaired += character;
            inString = true;
        } else if (character === '{' || character === '[') {
            repaired += character;
            stack.push(character);
        } else if (character === ':') {
            repaired += character;
            let cursor = index + 1;
            while (/\s/.test(source[cursor] || '')) {
                repaired += source[cursor];
                cursor++;
            }
            const rest = source.slice(cursor);
            const startsValidJsonValue = /^["{[]/.test(rest)
                || /^-?\d/.test(rest)
                || /^(?:true|false|null)(?=\s*[,}\]])/.test(rest);
            if (!startsValidJsonValue && rest) {
                let end = cursor;
                while (end < source.length && !/[,}\]\r\n]/.test(source[end])) end++;
                const bareValue = source.slice(cursor, end).trim();
                if (bareValue) {
                    repaired += JSON.stringify(bareValue);
                    index = end - 1;
                } else {
                    index = cursor - 1;
                }
            } else {
                index = cursor - 1;
            }
        } else if (character === ',' && stack.at(-1) === '[' && /^\s*"[^"\r\n]+"\s*:/.test(source.slice(index + 1))) {
            repaired += '],';
            stack.pop();
        } else if (character === '}' || character === ']') {
            const expected = character === '}' ? '{' : '[';
            while (stack.length && stack.at(-1) !== expected) repaired += closerFor(stack.pop());
            if (stack.at(-1) === expected) {
                stack.pop();
                repaired += character;
            }
        } else {
            repaired += character;
        }
    }

    if (inString) repaired += '"';
    while (stack.length) repaired += closerFor(stack.pop());
    return repaired.replace(/,\s*([}\]])/g, '$1');
}

function jsonAnalysisError(message, code, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    return error;
}

function extractJson(text) {
    const structured = findAnalysisPayload(text);
    if (structured) return structured;
    const raw = (typeof text === 'object' && text !== null ? responsePayloadToText(text) : String(text || '')).trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const candidate = fenced || (start >= 0 ? raw.slice(start, end >= start ? end + 1 : undefined) : '');
    if (!candidate) throw jsonAnalysisError('분석 결과에서 JSON을 찾지 못했습니다.', 'INVALID_ANALYSIS_JSON');
    try {
        return JSON.parse(candidate);
    } catch (error) {
        const structure = inspectJsonStructure(candidate);
        const trimmed = candidate.trimEnd();
        const structurallyIncomplete = structure.inString
            || (!structure.mismatched && structure.stack.length > 0)
            || !/[}\]]$/.test(trimmed);
        if (structurallyIncomplete && responseIndicatesTruncation(text)) {
            throw jsonAnalysisError(
                `분석 응답이 중간에 잘렸습니다. 현재 최대 출력 토큰은 ${Number(settings.maxTokens).toLocaleString()}입니다. 설정에서 값을 늘린 뒤 다시 분석해 주세요.`,
                'TRUNCATED_ANALYSIS_JSON',
                error,
            );
        }
        if (structurallyIncomplete) {
            throw jsonAnalysisError('모델 응답 형식이 중간에 끝났습니다.', 'INVALID_ANALYSIS_JSON', error);
        }
        try {
            const repaired = repairJsonCandidate(candidate);
            const parsed = JSON.parse(repaired);
            console.warn('[ChatLingo] Repaired malformed analysis JSON.', error);
            return parsed;
        } catch {
            // 자동 복구가 불가능한 경우에만 원래 오류를 사용자에게 구분해 안내한다.
        }
        throw jsonAnalysisError(
            `모델이 올바른 분석 형식을 반환하지 않았습니다. 다시 분석해 주세요. (${error.message})`,
            'INVALID_ANALYSIS_JSON',
            error,
        );
    }
}

function normalizeMaxTokens(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(parsed)));
}

function normalizePersonName(value) {
    return String(value || '').toLocaleLowerCase()
        .replace(/(?:さん|ちゃん|くん|君|様|씨|님|선생님|先生|mr|mrs|ms|miss|san|chan|kun)$/gi, '')
        .replace(/[\s\p{P}\p{S}]/gu, '');
}

function isCharacterNameVocabulary(item) {
    const label = `${item?.part_of_speech || ''} ${item?.meaning || ''}`;
    if (/인명|사람\s*이름|등장인물|person(?:al)?\s+name/i.test(label)) return true;
    const surface = normalizePersonName(item?.surface);
    if (!surface) return false;
    try {
        const context = getContext();
        const names = [context.name1, context.name2, ...(context.chat || []).map((message) => message?.name)]
            .map(normalizePersonName)
            .filter((name) => name.length >= 2);
        return names.some((name) => surface === name || (surface.length >= 2 && name.includes(surface)) || (name.length >= 2 && surface.includes(name)));
    } catch {
        return false;
    }
}

function analysisQualityError(message) {
    return jsonAnalysisError(message, 'LOW_QUALITY_ANALYSIS');
}

function normalizedAnalysisKey(value) {
    return String(value || '').toLocaleLowerCase().replace(/[\s_\-·.()[\]{}]+/g, '');
}

function findAnalysisField(data, aliases) {
    if (!data || typeof data !== 'object') return undefined;
    const wanted = new Set(aliases.map(normalizedAnalysisKey));
    let emptyMatch;
    for (const [key, value] of Object.entries(data)) {
        if (!wanted.has(normalizedAnalysisKey(key))) continue;
        const hasValue = value !== undefined && value !== null && value !== ''
            && (!Array.isArray(value) || value.length > 0)
            && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
        if (hasValue) return value;
        if (emptyMatch === undefined) emptyMatch = value;
    }
    return emptyMatch;
}

function analysisText(value, depth = 0, seen = new Set()) {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (value == null || typeof value !== 'object' || depth > 6 || seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => analysisText(item, depth + 1, seen)).filter(Boolean).join('\n');
    }
    const preferred = ['text', 'value', 'content', 'korean', 'ko', 'natural', 'result', 'translation', 'pronunciation', 'reading'];
    for (const key of preferred) {
        const found = findAnalysisField(value, [key]);
        const text = analysisText(found, depth + 1, seen);
        if (text) return text;
    }
    return Object.values(value).map((item) => analysisText(item, depth + 1, seen)).filter(Boolean).join('\n');
}

function analysisRows(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    const nested = findAnalysisField(value, ['items', 'entries', 'list', 'words', 'vocabulary', 'key_expressions', 'key_words', 'grammar']);
    if (nested !== undefined && nested !== value) return analysisRows(nested);
    return Object.values(value).filter((item) => item && typeof item === 'object');
}

function normalizeGrammarRow(item) {
    if (typeof item === 'string') {
        const [pattern, explanation = ''] = item.split(/\s*\|\|\|\s*|\s*:\s*/, 2);
        return { pattern: pattern || '', explanation };
    }
    return {
        pattern: analysisText(findAnalysisField(item, ['pattern', 'expression', 'surface', '표현', '문법'])),
        explanation: analysisText(findAnalysisField(item, ['explanation', 'description', 'meaning', '설명', '뜻'])),
    };
}

function normalizeVocabularyRow(item) {
    if (typeof item === 'string') {
        const fields = item.split(/\s*\|\|\|\s*/);
        return {
            surface: fields[0] || '', reading: fields[1] || '', korean_pronunciation: fields[2] || '',
            part_of_speech: fields[3] || '', meaning: fields[4] || '', nuance: fields[5] || '',
            example: fields[6] || '', example_translation: fields[7] || '',
        };
    }
    return {
        surface: analysisText(findAnalysisField(item, ['surface', 'word', 'term', 'expression', 'original', '원문표현', '표현', '단어'])),
        reading: analysisText(findAnalysisField(item, ['reading', 'furigana', 'kana', 'yomigana', '읽기', '후리가나'])),
        korean_pronunciation: analysisText(findAnalysisField(item, ['korean_pronunciation', 'korean pronunciation', 'pronunciation_ko', '한글발음', '한국어발음'])),
        part_of_speech: analysisText(findAnalysisField(item, ['part_of_speech', 'part of speech', 'pos', '품사'])),
        meaning: analysisText(findAnalysisField(item, ['meaning', 'korean_meaning', 'definition', '뜻', '문맥상뜻'])),
        nuance: analysisText(findAnalysisField(item, ['nuance', 'usage', '뉘앙스'])),
        example: analysisText(findAnalysisField(item, ['example', 'example_sentence', '새예문', '예문'])),
        example_translation: analysisText(findAnalysisField(item, ['example_translation', 'example translation', 'example_ko', '예문번역'])),
    };
}

function coerceAnalysisPayload(data) {
    const grammarValue = findAnalysisField(data, ['grammar', 'grammar_points', 'expressions', '문법', '표현문법']);
    const vocabularyValue = findAnalysisField(data, [
        'vocabulary', 'vocab', 'words', 'key_words', 'key_expressions', 'important_words', 'terms',
        '어휘', '단어', '핵심단어', '핵심표현', '주요표현', '중요단어',
    ]);
    return {
        language: analysisText(findAnalysisField(data, ['language', 'lang'])) === 'en' ? 'en' : settings.language,
        annotated: analysisText(findAnalysisField(data, ['annotated', 'annotated_text', 'furigana_text', 'text_with_furigana', 'original', 'original_text', '원문', '후리가나원문'])),
        translation: analysisText(findAnalysisField(data, ['translation', 'korean_translation', 'translated_text', 'translation_ko', '번역', '한국어번역'])),
        pronunciation: analysisText(findAnalysisField(data, ['pronunciation', 'korean_pronunciation', 'pronunciation_ko', 'hangul_pronunciation', '발음', '한글발음', '한국어발음'])),
        context_note: analysisText(findAnalysisField(data, ['context_note', 'context', 'contextual_meaning', 'usage_note', '문맥', '문맥설명', '문맥포인트'])),
        grammar: analysisRows(grammarValue).map(normalizeGrammarRow).filter((item) => item.pattern).slice(0, 8),
        vocabulary: analysisRows(vocabularyValue).map(normalizeVocabularyRow).filter((item) => item.surface && !isCharacterNameVocabulary(item)).slice(0, 16),
    };
}

function deriveVocabularyFromAnalysis(analysis, targetText = '') {
    const items = [];
    const seen = new Set();
    const add = (item) => {
        const surface = stripAnnotations(item?.surface || '').trim();
        const key = normalizePersonName(surface);
        if (!surface || !key || seen.has(key)) return;
        const normalizedItem = {
            surface,
            reading: String(item?.reading || '').trim(),
            korean_pronunciation: String(item?.korean_pronunciation || '').trim(),
            part_of_speech: String(item?.part_of_speech || '표현').trim(),
            meaning: String(item?.meaning || '문장 속 표현').trim(),
            nuance: String(item?.nuance || '').trim(),
            example: String(item?.example || '').trim(),
            example_translation: String(item?.example_translation || '').trim(),
        };
        if (isCharacterNameVocabulary(normalizedItem)) return;
        seen.add(key);
        items.push(normalizedItem);
    };

    const exactTarget = stripAnnotations(targetText).trim();
    if (settings.language === 'ja') {
        for (const match of canonicalizeFurigana(analysis.annotated).matchAll(/\{([^{}\[\]]+)\}\[([^\]]+)\]/g)) {
            const surface = match[1].trim();
            const grammar = analysis.grammar.find((item) => {
                const pattern = stripAnnotations(item?.pattern || '').trim();
                return pattern === surface || pattern.includes(surface) || surface.includes(pattern);
            });
            add({
                surface,
                reading: katakanaReadingToHiragana(match[2]).trim(),
                meaning: exactTarget === surface && /[가-힣]/.test(analysis.translation)
                    ? analysis.translation
                    : grammar?.explanation,
                part_of_speech: '표현',
            });
        }
    }
    for (const grammar of analysis.grammar) {
        add({
            surface: grammar.pattern,
            meaning: grammar.explanation,
            part_of_speech: '표현 · 문법',
        });
    }
    return items.slice(0, 16);
}

function kanaToKoreanApprox(value, maxSyllables = 3) {
    const kana = katakanaReadingToHiragana(value);
    const combinations = {
        きゃ: '캬', きゅ: '큐', きょ: '쿄', ぎゃ: '갸', ぎゅ: '규', ぎょ: '교',
        しゃ: '샤', しゅ: '슈', しょ: '쇼', じゃ: '쟈', じゅ: '쥬', じょ: '죠',
        ちゃ: '챠', ちゅ: '츄', ちょ: '쵸', にゃ: '냐', にゅ: '뉴', にょ: '뇨',
        ひゃ: '햐', ひゅ: '휴', ひょ: '효', びゃ: '뱌', びゅ: '뷰', びょ: '뵤',
        ぴゃ: '퍄', ぴゅ: '퓨', ぴょ: '표', みゃ: '먀', みゅ: '뮤', みょ: '묘',
        りゃ: '랴', りゅ: '류', りょ: '료', てぃ: '티', でぃ: '디', ふぁ: '파', ふぃ: '피', ふぇ: '페', ふぉ: '포',
    };
    const singles = {
        あ: '아', い: '이', う: '우', え: '에', お: '오',
        か: '카', き: '키', く: '쿠', け: '케', こ: '코', が: '가', ぎ: '기', ぐ: '구', げ: '게', ご: '고',
        さ: '사', し: '시', す: '스', せ: '세', そ: '소', ざ: '자', じ: '지', ず: '즈', ぜ: '제', ぞ: '조',
        た: '타', ち: '치', つ: '츠', て: '테', と: '토', だ: '다', ぢ: '지', づ: '즈', で: '데', ど: '도',
        な: '나', に: '니', ぬ: '누', ね: '네', の: '노', は: '하', ひ: '히', ふ: '후', へ: '헤', ほ: '호',
        ば: '바', び: '비', ぶ: '부', べ: '베', ぼ: '보', ぱ: '파', ぴ: '피', ぷ: '푸', ぺ: '페', ぽ: '포',
        ま: '마', み: '미', む: '무', め: '메', も: '모', や: '야', ゆ: '유', よ: '요',
        ら: '라', り: '리', る: '루', れ: '레', ろ: '로', わ: '와', を: '오', ヴ: '부', ゔ: '부',
    };
    let result = '';
    let syllables = 0;
    for (let index = 0; index < kana.length && syllables < maxSyllables; index++) {
        const pair = kana.slice(index, index + 2);
        const mapped = combinations[pair] || singles[kana[index]] || '';
        if (combinations[pair]) index++;
        if (!mapped) continue;
        result += mapped;
        syllables++;
    }
    return result;
}

function pronunciationCoverageIssue(targetText, pronunciation, language) {
    const targetLines = String(targetText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pronunciationLines = String(pronunciation || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!targetLines.length || !pronunciationLines.length) return '';
    if (targetLines.length > 1 && targetLines.length !== pronunciationLines.length) {
        return `한국어 발음이 원문 ${targetLines.length}줄 중 ${pronunciationLines.length}줄만 반환되었습니다.`;
    }
    const pairedLines = targetLines.length === pronunciationLines.length
        ? targetLines.map((line, index) => [line, pronunciationLines[index], index])
        : [[targetLines.join(' '), pronunciationLines.join(' '), 0]];
    for (const [source, spoken, index] of pairedLines) {
        const spokenCount = (spoken.match(/[가-힣]/g) || []).length;
        if (language === 'ja') {
            const sourceCount = (source.match(/[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/g) || []).length;
            if (sourceCount >= 8 && spokenCount / sourceCount < 0.62) {
                return `한국어 발음 ${index + 1}번째 줄에서 문장 중간 내용이 빠진 것으로 보입니다.`;
            }
        } else {
            // 영어 철자 수와 한글 음절 수는 비례하지 않는다. 예를 들어
            // "What are you doing?"(15자)은 "왓 아 유 두잉?"(6음절)이 정상이다.
            // 단어 덩어리와 전체 한글 음절이 모두 지나치게 적을 때만 누락으로 본다.
            const sourceWords = source.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
            const spokenGroups = spoken.match(/[가-힣]+/g) || [];
            const tooFewGroups = spokenGroups.length < Math.max(1, Math.ceil(sourceWords.length * 0.45));
            const tooFewSyllables = spokenCount < Math.max(1, Math.ceil(sourceWords.length * 0.9));
            if (sourceWords.length >= 5 && tooFewGroups && tooFewSyllables) {
                return `한국어 발음 ${index + 1}번째 줄에서 문장 중간 내용이 빠진 것으로 보입니다.`;
            }
        }
        if (language === 'ja') {
            const spokenHangul = spoken.replace(/[^가-힣]/g, '');
            const katakanaTerms = source.match(/[ァ-ヴ][ァ-ヴー]{1,}/g) || [];
            for (const term of katakanaTerms) {
                const expected = kanaToKoreanApprox(term, 2).replace(/[^가-힣]/g, '');
                if (expected.length >= 2 && !spokenHangul.includes(expected)) {
                    return `한국어 발음 ${index + 1}번째 줄에서 “${term}”의 발음이 빠졌습니다.`;
                }
            }
        }
    }
    return '';
}

function englishPronunciationNeeds(analysis, targetText) {
    if (settings.language !== 'en') return { sentenceIssue: '', wordIndexes: [] };
    const sentenceIssue = !/[가-힣]/.test(String(analysis?.pronunciation || ''))
        ? '전체 문장의 한글 발음이 비어 있습니다.'
        : pronunciationCoverageIssue(targetText, analysis.pronunciation, 'en');
    const wordIndexes = (analysis?.vocabulary || []).flatMap((item, index) => {
        const isEnglish = /[A-Za-z]/.test(String(item?.surface || ''));
        return isEnglish && !/[가-힣]/.test(String(item?.korean_pronunciation || '')) ? [index] : [];
    });
    return { sentenceIssue, wordIndexes };
}

function buildEnglishPronunciationRepairPrompt(targetText, vocabulary, needsSentence) {
    const wordRows = vocabulary.length
        ? vocabulary.map(({ id, surface }) => `${id} ||| ${surface}`).join('\n')
        : '(보충할 단어 없음)';
    return `당신은 한국인 영어 학습자를 위한 발음 표기 교정기다.
이미 완성된 분석의 다른 내용은 수정하거나 다시 분석하지 않는다. 아래에서 요구한 한글 발음만 출력한다.
영어 철자·로마자·IPA를 발음 대신 쓰지 말고, 한국인이 실제 소리를 따라 읽을 수 있는 자연스러운 한글로 쓴다.
문장 발음은 원문의 줄 수와 순서를 그대로 유지하며 이름과 중간 표현도 생략하지 않는다.

반드시 다음 형식만 출력한다.
[[PRONUNCIATION]]
${needsSentence ? '학습 대상 전체의 한글 발음' : '(보충 불필요)'}
[[WORD_PRONUNCIATIONS]]
각 ID ||| 해당 영어 표현의 한글 발음
[[END]]

[학습 대상 전체]
${String(targetText || '').replace(/\r\n?/g, '\n').trim()}

[한글 발음이 비어 있는 단어]
${wordRows}`;
}

function parseEnglishPronunciationRepair(response) {
    const raw = responsePayloadToText(response);
    const pronunciationSection = raw.match(/\[\[PRONUNCIATION\]\]\s*([\s\S]*?)(?=\n?\[\[[A-Z_]+\]\]|$)/i)?.[1]?.trim() || '';
    const pronunciation = String(pronunciationSection || salvageLabeledSection(
        raw,
        /^(?:(?:한국어|한글)\s*)?발음(?:\s*[:：]|$)|^pronunciation(?:\s*[:：]|$)/i,
    )).trim();
    const wordPronunciations = new Map();
    const wordSection = raw.match(/\[\[WORD_PRONUNCIATIONS\]\]\s*([\s\S]*?)(?=\n?\[\[[A-Z_]+\]\]|$)/i)?.[1] || raw;
    for (const line of wordSection.split(/\r?\n/)) {
        const match = line.replace(/^\s*[-*•]\s*/, '').trim().match(/^(E\d+)\s*(?:\|\|\||[:：])\s*(.+)$/i);
        if (!match) continue;
        const candidates = match[2].split(/\s*\|\|\|\s*/).map((value) => value.trim()).filter(Boolean);
        const korean = candidates.find((value) => /[가-힣]/.test(value)) || '';
        if (korean) wordPronunciations.set(match[1].toLocaleUpperCase(), korean);
    }
    return { pronunciation, wordPronunciations };
}

async function completeEnglishPronunciations(analysis, targetText, signal) {
    const needs = englishPronunciationNeeds(analysis, targetText);
    if (!needs.sentenceIssue && !needs.wordIndexes.length) return analysis;
    const missingWords = needs.wordIndexes.map((index, order) => ({
        index,
        id: `E${order + 1}`,
        surface: analysis.vocabulary[index].surface,
    }));
    setBusy(true, '빠진 영어 한글 발음만 보충하고 있어요.');
    try {
        const response = await requestAnalysis(
            buildEnglishPronunciationRepairPrompt(targetText, missingWords, Boolean(needs.sentenceIssue)),
            signal,
        );
        const repaired = parseEnglishPronunciationRepair(response);
        const completed = {
            ...analysis,
            vocabulary: (analysis.vocabulary || []).map((item) => ({ ...item })),
        };
        if (needs.sentenceIssue && /[가-힣]/.test(repaired.pronunciation)
            && !pronunciationCoverageIssue(targetText, repaired.pronunciation, 'en')) {
            completed.pronunciation = repaired.pronunciation;
            delete completed.pronunciation_incomplete;
        }
        for (const word of missingWords) {
            const korean = repaired.wordPronunciations.get(word.id);
            if (korean) completed.vocabulary[word.index].korean_pronunciation = korean;
        }
        return completed;
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        console.warn('[ChatLingo] English pronunciation-only repair failed:', error);
        return analysis;
    }
}

function validateAnalysis(data, targetText = '', { allowPartial = false } = {}) {
    if (!data || typeof data !== 'object') throw new Error('분석 결과 형식이 올바르지 않습니다.');
    const normalized = coerceAnalysisPayload(data);
    if (targetText) {
        normalized.annotated = settings.language === 'ja'
            ? rebuildJapaneseAnnotated(targetText, normalized.annotated, normalized.vocabulary)
            : String(targetText);
    } else if (settings.language === 'ja') {
        normalized.annotated = completeJapaneseFurigana(normalized.annotated, normalized.vocabulary);
    }
    if (!normalized.vocabulary.length) {
        normalized.vocabulary = deriveVocabularyFromAnalysis(normalized, targetText);
    }
    if (!normalized.annotated.trim() && !normalized.translation.trim()) {
        throw jsonAnalysisError('모델 응답에서 분석 내용을 찾지 못했습니다.', 'EMPTY_ANALYSIS');
    }

    const compactTarget = String(targetText || '').replace(/\s+/g, '');
    if (compactTarget && !/[가-힣]/.test(normalized.translation)) {
        throw analysisQualityError('모델이 한국어 번역을 제공하지 않았습니다.');
    }
    if (!allowPartial && compactTarget && !/[가-힣]/.test(normalized.pronunciation)) {
        throw analysisQualityError('모델이 한국어 발음을 제공하지 않았습니다.');
    }
    const pronunciationIssue = pronunciationCoverageIssue(targetText, normalized.pronunciation, settings.language);
    if (!allowPartial && pronunciationIssue) throw analysisQualityError(pronunciationIssue);
    if (allowPartial && pronunciationIssue) {
        normalized.pronunciation = '';
        normalized.pronunciation_incomplete = true;
    }
    if (settings.language === 'ja') {
        const targetTerms = String(targetText || '').match(/[\u3400-\u9FFF々〆ヵヶ]+|[\u30A1-\u30FA\u30FC]+/g) || [];
        const annotatedBases = [...normalized.annotated.matchAll(/\{([^{}\[\]]+)\}\[[^\]]+\]/g)]
            .map((match) => match[1] || '')
            .join('');
        const uncovered = targetTerms.filter((term) => ![...term].every((character) => annotatedBases.includes(character)));
        if (!allowPartial && uncovered.length) {
            throw analysisQualityError(`후리가나가 빠진 한자·가타카나가 있습니다: ${uncovered.slice(0, 3).join(', ')}`);
        }
        normalized.missing_furigana = uncovered;
    }
    return normalized;
}

async function loadProfileService() {
    if (profileService) return profileService;
    try {
        const shared = await import('../../shared.js');
        profileService = shared.ConnectionManagerRequestService;
    } catch (error) {
        console.warn('[ChatLingo] Connection Profile support unavailable:', error);
    }
    return profileService;
}

async function requestAnalysis(prompt, signal) {
    if (settings.connectionProfileId) {
        const service = await loadProfileService();
        if (!service) throw new Error('연결 프로필 기능을 불러올 수 없습니다.');
        const context = getContext();
        const profile = service.getProfile?.(settings.connectionProfileId);
        const apiMap = profile ? service.validateProfile?.(profile) : null;
        const isVertexAi = apiMap?.source === 'vertexai';
        const chatCompletionSettings = context.chatCompletionSettings || {};
        const providerOverrides = isVertexAi ? {
            // Connection Manager 단독 요청에는 본채팅의 Vertex 인증 정보가 자동으로
            // 포함되지 않으므로 챗링고가 동일한 인증 모드·프로젝트·리전을 전달한다.
            vertexai_auth_mode: chatCompletionSettings.vertexai_auth_mode || 'express',
            vertexai_region: profile?.['api-url'] || chatCompletionSettings.vertexai_region || 'us-central1',
            vertexai_express_project_id: chatCompletionSettings.vertexai_express_project_id || '',
        } : {};
        const messages = [
            { role: 'system', content: 'This is a deterministic language-learning data transformation, not roleplay or creative writing. Preserve the complete source text. Every requested field and language rule is mandatory. Follow the requested section format exactly, output Korean explanations, and output no Markdown fences, preface, or commentary.' },
            { role: 'user', content: prompt },
        ];
        const performRequest = async () => {
            const result = await service.sendRequest(settings.connectionProfileId, messages, settings.maxTokens, {
                // 긴 사고 모델도 중간 청크를 보내 연결을 유지하도록 스트리밍으로 요청한다.
                stream: true,
                signal,
                // 공급자마다 다른 응답 껍데기는 실리태번이 벗기고 실제 텍스트만 받는다.
                // json_schema를 요청하지 않으므로 모델이 JSON을 틀려도 여기서 파싱하지 않는다.
                extractData: true,
                // 캐릭터 역할극 프리셋이 학습 형식보다 우선하지 않도록 분석 요청에서 제외한다.
                includePreset: false,
                includeInstruct: true,
            }, { temperature: 0, ...providerOverrides });
            if (typeof result !== 'function') return result;
            let finalText = '';
            let finalReasoning = '';
            for await (const chunk of result()) {
                if (typeof chunk?.text === 'string') finalText = chunk.text;
                if (typeof chunk?.state?.reasoning === 'string') finalReasoning = chunk.state.reasoning;
            }
            return { content: finalText, reasoning: finalReasoning };
        };
        try {
            return await performRequest();
        } catch (error) {
            if (signal?.aborted || !isAbortError(error)) throw error;
            setBusy(true, '연결이 잠시 끊겨 분석 요청을 한 번 다시 보내고 있어요.');
            return await performRequest();
        }
    }

    const context = getContext();
    if (typeof context.generateRaw === 'function') {
        return await context.generateRaw({
            prompt,
            systemPrompt: 'This is a deterministic language-learning data transformation, not roleplay. Preserve the complete source text and obey every requested format and language rule. Output no Markdown fences, preface, or commentary.',
            responseLength: settings.maxTokens,
            trimNames: false,
            signal,
        });
    }
    if (typeof context.generateQuietPrompt === 'function') {
        return await context.generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true, signal });
    }
    throw new Error('현재 실리태번에서 사용할 수 있는 생성 API를 찾지 못했습니다.');
}

function setBusy(busy, message = '') {
    const button = document.getElementById('chatlingo-analyze');
    const status = document.getElementById('chatlingo-status');
    if (button) {
        button.setAttribute('aria-busy', String(busy));
        button.innerHTML = busy
            ? `<span class="chatlingo-spinner"></span> 분석 중… <span class="chatlingo-cancel">취소</span>`
            : `${icon('sparkle')} 분석 시작`;
    }
    if (status) {
        status.hidden = !message;
        status.textContent = message;
    }
}

function readableErrorMessage(error) {
    const messages = [];
    let current = error;
    for (let depth = 0; current && depth < 8; depth++) {
        if (current.message) messages.push(String(current.message));
        current = current.cause;
    }
    for (let index = messages.length - 1; index >= 0; index--) {
        if (!/^(?:API request failed|Request failed)$/i.test(messages[index].trim())) return messages[index];
    }
    return messages[messages.length - 1] || '알 수 없는 오류';
}

function isAbortError(error) {
    let current = error;
    for (let depth = 0; current && depth < 8; depth++) {
        if (current.name === 'AbortError' || /\b(?:abort|aborted)\b/i.test(String(current.message || ''))) return true;
        current = current.cause;
    }
    return false;
}

async function analyze() {
    if (activeController) {
        // 모바일의 중복 탭이 새 요청 직후 곧바로 취소로 처리되는 것을 막는다.
        if (Date.now() - analysisStartedAt < 1200) return;
        activeController.abort();
        return;
    }
    const text = document.getElementById('chatlingo-input').value.trim();
    if (!text) {
        toast('info', '학습할 문장이나 단어를 입력해 주세요.');
        return;
    }
    const narrativeContext = document.getElementById('chatlingo-context').value.trim();
    const automaticContext = recentContext(text);
    const contextText = [
        participantNameContext(),
        automaticContext ? `[최근 대화]\n${automaticContext}` : '',
        narrativeContext ? `[추가 서사]\n${narrativeContext}` : '',
    ].filter(Boolean).join('\n\n');
    activeController = new AbortController();
    analysisStartedAt = Date.now();
    setBusy(true, '채팅과 분리된 학습 요청을 보내고 있어요. 채팅은 계속 사용할 수 있습니다.');
    try {
        const response = await requestAnalysis(buildSectionPrompt(text, contextText), activeController.signal);
        let parsed;
        let firstPayload = null;
        let repairedPayload = null;
        let partialWarning = '';
        try {
            firstPayload = parseAnalysisPayload(response);
            parsed = validateAnalysis(firstPayload, text);
        } catch (error) {
            if (!['INVALID_ANALYSIS_JSON', 'EMPTY_ANALYSIS', 'TRUNCATED_ANALYSIS_JSON', 'LOW_QUALITY_ANALYSIS'].includes(error?.code)) throw error;
            setBusy(true, '후리가나와 학습 항목을 다시 확인해 분석하고 있어요.');
            const repairedResponse = await requestAnalysis(buildStrictRetryPrompt(text, contextText, error.message, response), activeController.signal);
            try {
                repairedPayload = parseAnalysisPayload(repairedResponse);
                parsed = validateAnalysis(repairedPayload, text);
            } catch (retryError) {
                if (!['INVALID_ANALYSIS_JSON', 'EMPTY_ANALYSIS', 'TRUNCATED_ANALYSIS_JSON', 'LOW_QUALITY_ANALYSIS'].includes(retryError?.code)) throw retryError;
                const parsedMerged = mergeAnalysisPayloads(repairedPayload, firstPayload);
                const salvaged = salvageAnalysisResponses(repairedResponse, response);
                const merged = mergeAnalysisPayloads(parsedMerged, salvaged);
                try {
                    parsed = validateAnalysis(merged, text);
                } catch (mergedError) {
                    try {
                        parsed = validateAnalysis(merged, text, { allowPartial: true });
                        const warnings = [];
                        if (!/[가-힣]/.test(parsed.pronunciation)) warnings.push('한글 발음');
                        if (parsed.missing_furigana?.length) warnings.push(`후리가나 ${parsed.missing_furigana.slice(0, 3).join(', ')}`);
                        if (!parsed.vocabulary.length) warnings.push('핵심 단어');
                        partialWarning = warnings.length
                            ? `모델이 ${warnings.join(' · ')} 항목을 빠뜨려 나머지 분석만 표시했습니다.`
                            : '';
                    } catch {
                        throw analysisQualityError(`응답을 두 번 받아 자동 복구했지만 한국어 분석 내용을 확인할 수 없습니다. ${mergedError.message || retryError.message}`);
                    }
                }
            }
        }
        parsed = await completeEnglishPronunciations(parsed, text, activeController.signal);
        const finalWarnings = [];
        const finalPronunciationNeeds = englishPronunciationNeeds(parsed, text);
        if (settings.language === 'en' && finalPronunciationNeeds.sentenceIssue) finalWarnings.push('문장 한글 발음');
        if (settings.language === 'en' && finalPronunciationNeeds.wordIndexes.length) {
            finalWarnings.push(`단어 한글 발음 ${finalPronunciationNeeds.wordIndexes.length}개`);
        }
        if (settings.language === 'ja') {
            const japanesePronunciationIssue = !/[가-힣]/.test(String(parsed.pronunciation || ''))
                || pronunciationCoverageIssue(text, parsed.pronunciation, 'ja');
            if (japanesePronunciationIssue) finalWarnings.push('한글 발음');
        }
        if (parsed.missing_furigana?.length) finalWarnings.push(`후리가나 ${parsed.missing_furigana.slice(0, 3).join(', ')}`);
        if (!parsed.vocabulary.length) finalWarnings.push('핵심 단어');
        partialWarning = finalWarnings.length
            ? `모델이 ${finalWarnings.join(' · ')} 항목을 끝까지 빠뜨려 나머지 분석만 표시했습니다.`
            : '';
        lastAnalysis = parsed;
        renderResult(lastAnalysis);
        document.getElementById('chatlingo-status').hidden = true;
        if (partialWarning) toast('warning', partialWarning);
    } catch (error) {
        if (isAbortError(error) && activeController?.signal.aborted) {
            toast('info', '분석을 취소했습니다.');
        } else {
            console.error('[ChatLingo] Analysis failed:', error);
            setBusy(false, `분석하지 못했습니다: ${readableErrorMessage(error)}`);
            return;
        }
    } finally {
        activeController = null;
        analysisStartedAt = 0;
        if (!document.getElementById('chatlingo-status')?.textContent?.startsWith('분석하지')) setBusy(false);
    }
}

function annotatedToRuby(value) {
    const source = canonicalizeFurigana(value);
    const pattern = /\{([^{}\[\]]+)\}\[([^\]]+)\]/g;
    let html = '';
    let last = 0;
    for (const match of source.matchAll(pattern)) {
        html += escapeHtml(source.slice(last, match.index));
        const base = match[1];
        const reading = match[2];
        html += `<ruby>${escapeHtml(base)}<rp>(</rp><rt>${escapeHtml(reading)}</rt><rp>)</rp></ruby>`;
        last = match.index + match[0].length;
    }
    return html + escapeHtml(source.slice(last));
}

function resultCard(item, index, language) {
    const reading = item.reading ? `<span>${escapeHtml(item.reading)}</span>` : '';
    const pronunciation = item.korean_pronunciation ? `<span class="chatlingo-pron">${escapeHtml(item.korean_pronunciation)}</span>` : '';
    return `<article class="chatlingo-word-card">
        <div class="chatlingo-word-top">
            <div><label class="chatlingo-word-select"><input type="checkbox" data-word-select="${index}" checked aria-label="${escapeHtml(item.surface)} 선택"><span></span></label><strong>${escapeHtml(item.surface)}</strong>${reading}${pronunciation}</div>
            <div class="chatlingo-card-actions">
                <button data-speak="${escapeHtml(item.surface)}" data-lang="${language}">음성</button>
                <button data-save-word="${index}">저장</button>
            </div>
        </div>
        <div class="chatlingo-meaning"><small>${escapeHtml(item.part_of_speech || '표현')}</small>${escapeHtml(item.meaning)}</div>
        ${item.nuance ? `<p>${escapeHtml(item.nuance)}</p>` : ''}
        ${item.example ? `<div class="chatlingo-example"><span>${escapeHtml(item.example)}</span><small>${escapeHtml(item.example_translation || '')}</small><button data-speak="${escapeHtml(item.example)}" data-lang="${language}">예문 음성</button></div>` : ''}
    </article>`;
}

function renderResult(data) {
    const result = document.getElementById('chatlingo-result');
    result.hidden = false;
    const originalHtml = data.language === 'ja' ? annotatedToRuby(data.annotated) : escapeHtml(data.annotated);
    const grammar = data.grammar.map((item) => `<li><strong>${escapeHtml(item.pattern)}</strong><span>${escapeHtml(item.explanation)}</span></li>`).join('');
    const vocabulary = data.vocabulary.map((item, index) => resultCard(item, index, data.language)).join('');
    result.innerHTML = `
        <section class="chatlingo-hero-result">
            <div class="chatlingo-result-actions">
                <button data-speak="${escapeHtml(stripAnnotations(data.annotated))}" data-lang="${data.language}" data-tts-mode="mixed">${icon('play')} 전체 듣기</button>
                <button data-action="copy-result">${icon('copy')} 복사</button>
                <button data-action="clear-result">${icon('trash')} 결과 지우기</button>
            </div>
            <div class="chatlingo-original">${originalHtml}</div>
            ${data.pronunciation ? `<div class="chatlingo-full-pron">${escapeHtml(data.pronunciation)}</div>` : ''}
            <div class="chatlingo-translation">${escapeHtml(data.translation)}</div>
            ${data.context_note ? `<div class="chatlingo-context-note"><strong>문맥 포인트</strong>${escapeHtml(data.context_note)}</div>` : ''}
        </section>
        ${grammar ? `<section class="chatlingo-analysis-block"><h3>표현 · 문법</h3><ul>${grammar}</ul></section>` : ''}
        <section class="chatlingo-analysis-block"><div class="chatlingo-vocabulary-heading"><h3>핵심 단어 · 표현 <span>${data.vocabulary.length}</span></h3>${data.vocabulary.length ? '<div class="chatlingo-bulk-actions"><label><input id="chatlingo-select-all" type="checkbox" checked> 전체 선택</label><button data-action="save-selected">선택 저장</button></div>' : ''}</div><div class="chatlingo-word-list">${vocabulary || '<p>추출된 단어가 없습니다.</p>'}</div></section>`;
}

function clearAnalysisResult() {
    stopSpeech();
    lastAnalysis = null;
    const result = document.getElementById('chatlingo-result');
    if (result) {
        result.replaceChildren();
        result.hidden = true;
    }
    const status = document.getElementById('chatlingo-status');
    if (status) {
        status.textContent = '';
        status.hidden = true;
    }
    toast('success', '분석 결과를 지웠습니다. 학습할 문장과 저장한 단어장은 그대로예요.');
}

function stripAnnotations(text) {
    return canonicalizeFurigana(text)
        .replace(/\{([^{}]+)\}\[([^\]]+)\]/g, '$1')
        .replace(/\[([^\]]+)\]/g, '');
}

function refreshVoices() {
    const status = document.getElementById('chatlingo-voice-status');
    if (status) status.hidden = settings.ttsSource !== 'browser';
    if (!('speechSynthesis' in globalThis)) {
        for (const language of ['ja', 'en']) {
            const select = document.getElementById(`chatlingo-voice-${language}`);
            if (select) {
                select.innerHTML = '<option value="">지원되지 않음</option>';
                select.disabled = true;
            }
        }
        if (status) status.textContent = '현재 브라우저에서는 무료 음성 읽기를 사용할 수 없습니다.';
        return;
    }
    voices = globalThis.speechSynthesis.getVoices();
    const voiceCounts = { ja: 0, en: 0 };
    for (const language of ['ja', 'en']) {
        const select = document.getElementById(`chatlingo-voice-${language}`);
        if (!select) continue;
        const prefixes = language === 'ja' ? ['ja'] : ['en'];
        const matches = voices.filter((voice) => prefixes.some((prefix) => voice.lang.toLowerCase().startsWith(prefix)));
        voiceCounts[language] = matches.length;
        select.innerHTML = `<option value="">자동 선택 (이 기기·브라우저)</option>` + matches.map((voice) =>
            `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join('');
        select.value = language === 'ja' ? settings.ttsVoiceJa : settings.ttsVoiceEn;
    }
    if (status) {
        status.textContent = voices.length
            ? `현재 환경에서 일본어 ${voiceCounts.ja}개, 영어 ${voiceCounts.en}개 음성을 찾았습니다.`
            : '현재 환경에서 사용할 수 있는 음성을 찾지 못했습니다. 잠시 후 다시 확인하거나 기기의 음성 설정을 확인해 주세요.';
    }
}

function resetSpeechButton(button = activeSpeech?.button) {
    if (!button?.isConnected) return;
    button.classList.remove('is-speaking');
    button.removeAttribute('aria-pressed');
    button.innerHTML = button.dataset.speechOriginalHtml || button.innerHTML;
    delete button.dataset.speechOriginalHtml;
}

function clearTtsIntegrationMonitor() {
    if (ttsIntegrationMonitor) clearInterval(ttsIntegrationMonitor);
    ttsIntegrationMonitor = null;
}

function updateTtsSourceUi() {
    const useSillyTavern = settings.ttsSource === 'sillytavern';
    for (const id of ['chatlingo-voice-ja', 'chatlingo-voice-en', 'chatlingo-rate']) {
        const control = document.getElementById(id);
        if (control) control.disabled = useSillyTavern;
    }
    const help = document.getElementById('chatlingo-tts-source-help');
    const voiceStatus = document.getElementById('chatlingo-voice-status');
    if (voiceStatus) voiceStatus.hidden = useSillyTavern;
    if (help) {
        help.textContent = useSillyTavern
            ? '실리태번 TTS에 설정된 API와 현재 캐릭터의 음성 맵을 사용해요. 실리태번 TTS가 켜져 있고 캐릭터 목소리가 지정돼 있어야 합니다.'
            : '기본 음성은 기기·운영체제·브라우저에 따라 종류와 품질이 다를 수 있어요.';
    }
}

function findSillyTavernNarrationTarget(context) {
    for (let index = (context.chat || []).length - 1; index >= 0; index -= 1) {
        const message = context.chat[index];
        if (!message || message.is_user || message.is_system) continue;
        const row = document.querySelector(`.mes[mesid="${index}"]`);
        const narrateButton = row?.querySelector('.mes_narrate');
        if (narrateButton) return { message, narrateButton };
    }
    return null;
}

function speakViaSillyTavern(cleanText, button) {
    const context = getContext();
    const ttsSettings = context.extensionSettings?.tts || {};
    if (!ttsSettings.enabled) {
        toast('info', '먼저 실리태번의 TTS 확장을 켜고 캐릭터 목소리를 설정해 주세요.');
        return;
    }
    const target = findSillyTavernNarrationTarget(context);
    if (!target) {
        toast('info', '현재 채팅에서 음성을 연결할 AI 메시지를 찾지 못했습니다. AI 답변이 하나 이상 있는 채팅에서 다시 시도해 주세요.');
        return;
    }
    stopSpeech();
    const speechState = { source: 'sillytavern', button, text: cleanText };
    activeSpeech = speechState;
    if (button) {
        button.dataset.speechOriginalHtml = button.innerHTML;
        button.classList.add('is-speaking');
        button.setAttribute('aria-pressed', 'true');
        button.innerHTML = `${icon('stop')} 중지`;
    }
    const startedAt = Date.now();
    let playbackStarted = false;
    clearTtsIntegrationMonitor();
    ttsIntegrationMonitor = setInterval(() => {
        if (activeSpeech !== speechState) {
            clearTtsIntegrationMonitor();
            return;
        }
        const control = document.getElementById('tts_media_control');
        const audio = document.getElementById('tts_audio');
        const busy = Boolean(control?.classList.contains('fa-stop-circle') || (audio && !audio.paused));
        playbackStarted ||= busy;
        if ((playbackStarted && !busy) || (!playbackStarted && Date.now() - startedAt > 3000)) {
            resetSpeechButton(button);
            activeSpeech = null;
            clearTtsIntegrationMonitor();
        }
    }, 100);
    const originalMessage = target.message.mes;
    const originalExtra = target.message.extra;
    // The official message narration path is provider-agnostic. Wrapping the
    // learning text marks it as dialogue when SillyTavern multi-voice is on.
    const preserveMixedVoices = button?.dataset.ttsMode === 'mixed';
    const narrationText = ttsSettings.multi_voice_enabled && !preserveMixedVoices
        ? `「${cleanText.replace(/[\r\n]+/g, ' ')}」`
        : cleanText;
    try {
        target.message.mes = narrationText;
        if (ttsSettings.narrate_translated_only) {
            target.message.extra = { ...(originalExtra || {}), display_text: narrationText };
        }
        target.narrateButton.click();
    } catch (error) {
        clearTtsIntegrationMonitor();
        resetSpeechButton(button);
        if (activeSpeech === speechState) activeSpeech = null;
        toast('error', error?.message || '실리태번 TTS 연결에 실패했습니다.');
    } finally {
        target.message.mes = originalMessage;
        target.message.extra = originalExtra;
    }
}

function splitSpeechText(text, maxLength = 220) {
    const pieces = String(text || '').match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) || [String(text || '')];
    const chunks = [];
    for (const piece of pieces.map((value) => value.trim()).filter(Boolean)) {
        if (piece.length <= maxLength) {
            chunks.push(piece);
            continue;
        }
        let rest = piece;
        while (rest.length > maxLength) {
            let cut = rest.lastIndexOf(' ', maxLength);
            if (cut < Math.round(maxLength * 0.55)) cut = maxLength;
            chunks.push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
        }
        if (rest) chunks.push(rest);
    }
    return chunks;
}

function playNextSpeechChunk(speechState) {
    if (activeSpeech !== speechState) return;
    const chunk = speechState.chunks[speechState.index];
    if (!chunk) {
        resetSpeechButton(speechState.button);
        activeSpeech = null;
        return;
    }
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = speechState.language === 'ja' ? 'ja-JP' : 'en-US';
    utterance.rate = Number(settings.ttsRate);
    utterance.pitch = Number(settings.ttsPitch);
    utterance.volume = Number(settings.ttsVolume);
    const voiceId = speechState.language === 'ja' ? settings.ttsVoiceJa : settings.ttsVoiceEn;
    const voice = voices.find((candidate) => candidate.voiceURI === voiceId);
    if (voice) utterance.voice = voice;
    speechState.utterance = utterance;
    utterance.addEventListener('end', () => {
        if (activeSpeech !== speechState) return;
        speechState.index += 1;
        playNextSpeechChunk(speechState);
    }, { once: true });
    utterance.addEventListener('error', () => {
        if (activeSpeech !== speechState) return;
        resetSpeechButton(speechState.button);
        activeSpeech = null;
    }, { once: true });
    globalThis.speechSynthesis.speak(utterance);
}

function speak(text, language = settings.language, button = null) {
    const cleanText = stripAnnotations(text);
    if (activeSpeech && activeSpeech.button === button && activeSpeech.text === cleanText) {
        stopSpeech();
        return;
    }
    if (settings.ttsSource === 'sillytavern') {
        void speakViaSillyTavern(cleanText, button);
        return;
    }
    if (!('speechSynthesis' in globalThis)) {
        toast('error', '이 브라우저는 무료 음성 읽기를 지원하지 않습니다.');
        return;
    }
    stopSpeech();
    const speechState = { source: 'browser', button, text: cleanText, language, chunks: splitSpeechText(cleanText), index: 0, utterance: null };
    activeSpeech = speechState;
    if (button) {
        button.dataset.speechOriginalHtml = button.innerHTML;
        button.classList.add('is-speaking');
        button.setAttribute('aria-pressed', 'true');
        button.innerHTML = `${icon('stop')} 중지`;
    }
    playNextSpeechChunk(speechState);
}

function stopSpeech() {
    const previous = activeSpeech;
    activeSpeech = null;
    clearTtsIntegrationMonitor();
    if (previous?.source === 'sillytavern') {
        document.getElementById('ttsExtensionMenuItem')?.click();
    } else {
        globalThis.speechSynthesis?.cancel();
    }
    resetSpeechButton(previous?.button);
}

function saveWord(index) {
    const word = lastAnalysis?.vocabulary?.[index];
    if (!word) return;
    const language = inferWordLanguage(word.surface, lastAnalysis.language);
    const key = `${language}:${word.surface}:${word.meaning}`;
    const duplicate = settings.savedWords.some((item) => item.key === key);
    if (duplicate) {
        toast('info', '이미 단어장에 있는 표현입니다.');
        return;
    }
    settings.savedWords.unshift({
        ...word,
        key,
        language,
        savedAt: new Date().toISOString(),
    });
    settings.savedWords = settings.savedWords.slice(0, MAX_SAVED_WORDS);
    saveSettings();
    renderWordbook();
    toast('success', `“${word.surface}”을(를) 저장했습니다.`);
}

function saveSelectedWords() {
    const indices = [...document.querySelectorAll('[data-word-select]:checked')].map((input) => Number(input.dataset.wordSelect));
    if (!indices.length) {
        toast('info', '저장할 단어를 먼저 선택해 주세요.');
        return;
    }
    const existingKeys = new Set(settings.savedWords.map((item) => item.key || `${item.language}:${item.surface}:${item.meaning}`));
    const additions = indices.map((index) => lastAnalysis?.vocabulary?.[index]).filter(Boolean).flatMap((word) => {
        const language = inferWordLanguage(word.surface, lastAnalysis.language);
        const key = `${language}:${word.surface}:${word.meaning}`;
        if (existingKeys.has(key)) return [];
        existingKeys.add(key);
        return [{ ...word, key, language, savedAt: new Date().toISOString() }];
    });
    settings.savedWords = [...additions.reverse(), ...settings.savedWords].slice(0, MAX_SAVED_WORDS);
    saveSettings();
    renderWordbook();
    toast(additions.length ? 'success' : 'info', additions.length ? `${additions.length}개 표현을 저장했습니다.` : '선택한 표현이 이미 모두 저장되어 있습니다.');
}

function removeWord(index) {
    const word = settings.savedWords[index];
    if (!word) return;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`“${word.surface}”을 단어장에서 삭제할까요?`)) return;
    settings.savedWords.splice(index, 1);
    editingSavedWordIndex = null;
    saveSettings();
    renderWordbook();
    toast('success', '단어를 삭제했습니다.');
}

function beginSavedWordEdit(index) {
    if (!settings.savedWords[index]) return;
    editingSavedWordIndex = index;
    renderWordbook();
}

function cancelSavedWordEdit() {
    editingSavedWordIndex = null;
    renderWordbook();
}

function saveSavedWordEdit(index) {
    const word = settings.savedWords[index];
    const form = document.querySelector(`[data-saved-edit="${index}"]`);
    if (!word || !form) return;
    const read = (field) => String(form.querySelector(`[data-edit-field="${field}"]`)?.value || '').trim();
    const surface = read('surface');
    if (!surface) {
        toast('info', '단어 표기는 비워둘 수 없습니다.');
        return;
    }
    const fields = ['reading', 'korean_pronunciation', 'part_of_speech', 'meaning', 'nuance', 'example', 'example_translation'];
    const next = { ...word, surface };
    for (const field of fields) next[field] = read(field);
    next.language = inferWordLanguage(next.surface, word.language);
    next.key = `${next.language}:${next.surface}:${next.meaning}`;
    const duplicate = settings.savedWords.some((item, itemIndex) => itemIndex !== index
        && (item.key || `${item.language}:${item.surface}:${item.meaning}`) === next.key);
    if (duplicate) {
        toast('info', '같은 표기와 뜻을 가진 단어가 이미 있습니다.');
        return;
    }
    settings.savedWords[index] = next;
    editingSavedWordIndex = null;
    saveSettings();
    renderWordbook();
    toast('success', '단어 내용을 수정했습니다.');
}

function deleteSelectedSavedWords() {
    const selected = new Set([...document.querySelectorAll('[data-saved-select]:checked')].map((input) => Number(input.dataset.savedSelect)));
    if (!selected.size) {
        toast('info', '삭제할 단어를 먼저 선택해 주세요.');
        return;
    }
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`선택한 ${selected.size}개 단어를 삭제할까요?`)) return;
    settings.savedWords = settings.savedWords.filter((_, index) => !selected.has(index));
    editingSavedWordIndex = null;
    saveSettings();
    renderWordbook();
    toast('success', `${selected.size}개 단어를 삭제했습니다.`);
}

function duplicateWordKey(item) {
    const language = inferWordLanguage(item?.surface, item?.language);
    let surface = stripAnnotations(item?.surface || '').normalize('NFKC').trim();
    surface = language === 'ja'
        ? surface.replace(/\s+/g, '')
        : surface.replace(/\s+/g, ' ').toLocaleLowerCase();
    surface = surface.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    return surface ? `${language}:${surface}` : '';
}

function mergeUniqueText(items, separator = ' · ') {
    const values = [];
    const seen = new Set();
    for (const item of items) {
        for (const part of String(item || '').split(/\s+·\s+/)) {
            const value = part.trim();
            const key = value.normalize('NFKC').toLocaleLowerCase();
            if (!value || seen.has(key)) continue;
            seen.add(key);
            values.push(value);
        }
    }
    return values.join(separator);
}

function mergeWordGroup(group) {
    const sorted = [...group].sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')));
    const base = { ...sorted[0] };
    const examplePairs = [];
    const seenExamples = new Set();
    for (const item of sorted) {
        const example = String(item.example || '').trim();
        if (!example || seenExamples.has(example)) continue;
        seenExamples.add(example);
        examplePairs.push({ example, translation: String(item.example_translation || '').trim() });
    }
    base.surface = String(sorted.find((item) => item.surface)?.surface || '').trim();
    base.reading = mergeUniqueText(sorted.map((item) => item.reading));
    base.korean_pronunciation = mergeUniqueText(sorted.map((item) => item.korean_pronunciation));
    base.part_of_speech = mergeUniqueText(sorted.map((item) => item.part_of_speech));
    base.meaning = mergeUniqueText(sorted.map((item) => item.meaning));
    base.nuance = mergeUniqueText(sorted.map((item) => item.nuance));
    base.example = examplePairs.map((item) => item.example).join(' / ');
    base.example_translation = examplePairs.map((item) => item.translation).filter(Boolean).join(' / ');
    base.savedAt = sorted[0]?.savedAt || new Date().toISOString();
    base.key = `${base.language}:${base.surface}:${base.meaning}`;
    return base;
}

function planDuplicateWordMerge(words = settings.savedWords) {
    const groups = new Map();
    for (const item of words) {
        const key = duplicateWordKey(item);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const duplicateGroups = new Map([...groups].filter(([, group]) => group.length > 1));
    const emitted = new Set();
    const mergedWords = [];
    for (const item of words) {
        const key = duplicateWordKey(item);
        const duplicateGroup = duplicateGroups.get(key);
        if (!duplicateGroup) {
            mergedWords.push(item);
            continue;
        }
        if (emitted.has(key)) continue;
        emitted.add(key);
        mergedWords.push(mergeWordGroup(duplicateGroup));
    }
    return {
        mergedWords,
        groupCount: duplicateGroups.size,
        removedCount: words.length - mergedWords.length,
    };
}

function mergeDuplicateWords() {
    const plan = planDuplicateWordMerge();
    if (!plan.removedCount) {
        toast('info', '병합할 중복 단어가 없습니다.');
        return;
    }
    const message = `같은 표기의 중복 단어 ${plan.groupCount}묶음을 병합할까요?\n중복 카드 ${plan.removedCount}개가 합쳐지며, 서로 다른 뜻·읽기·품사·뉘앙스는 모두 보존됩니다.`;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(message)) return;
    settings.savedWords = plan.mergedWords;
    editingSavedWordIndex = null;
    wordbookView.page = 1;
    saveSettings();
    renderWordbook();
    toast('success', `중복 단어 ${plan.groupCount}묶음을 합쳤습니다.`);
}

function wordbookSurfaceKey(value) {
    return stripAnnotations(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function buildWordbookEnrichmentPrompt(entries, language, retry = false) {
    const languageName = language === 'ja' ? '일본어' : '영어';
    const rows = entries.map(({ requestId, item }) => [
        requestId,
        String(item.surface || '').replace(/\s*\|\|\|\s*/g, ' '),
        String(item.reading || '').replace(/\s*\|\|\|\s*/g, ' '),
        String(item.korean_pronunciation || '').replace(/\s*\|\|\|\s*/g, ' '),
    ].join(' ||| ')).join('\n');
    return `당신은 한국인을 위한 ${languageName} 사전 편집자다.
아래 단어장 항목은 뜻이 비어 있다. 각 항목의 기본적이고 자연스러운 한국어 뜻을 채워라.
문장 문맥이 없으므로 가장 일반적인 뜻을 우선하되, 활용형이면 기본형과 활용 의미를 함께 간단히 설명한다.
사람 이름으로 보이는 표현은 삭제하지 말고 "인명·고유명사"라고 분류한다.
${retry ? '이전 응답에서 일부 항목이 누락되었다. 이번에는 아래의 모든 ID를 정확히 한 번씩 반드시 출력한다.' : '입력된 모든 ID를 빠짐없이 정확히 한 번씩 출력한다.'}

JSON, 코드블록, 표, 머리말을 쓰지 말고 아래 형식만 출력한다.
각 행의 필드는 정확히 ||| 로 구분하며, ID와 원문 표기를 바꾸지 않는다.
[[VOCABULARY]]
ID ||| 원문 표기 ||| 읽기 ||| 한글 발음 ||| 품사 ||| 한국어 뜻 ||| 한국어 뉘앙스 ||| 짧은 새 예문 ||| 한국어 예문 번역
[[END]]

규칙:
- 한국어 뜻에는 반드시 한글을 포함한다.
- 일본어 읽기는 히라가나로, 한글 발음은 한국인이 읽을 수 있는 한글로 쓴다.
- 영어는 읽기 칸을 비워도 되지만 한글 발음은 쓴다.
- 기존 읽기와 한글 발음이 입력되어 있으면 존중하고, 잘못된 경우에만 바로잡는다.
- 설명은 짧고 사전처럼 명확하게 쓴다.

[ID ||| 원문 표기 ||| 기존 읽기 ||| 기존 한글 발음]
${rows}`;
}

function parseWordbookEnrichmentResponse(response, entries) {
    const raw = responsePayloadToText(response).trim();
    const parsed = new Map();
    const byId = new Map(entries.map((entry) => [entry.requestId.toLocaleUpperCase(), entry]));
    const unmatchedBySurface = new Map();
    for (const entry of entries) {
        const key = wordbookSurfaceKey(entry.item.surface);
        if (!unmatchedBySurface.has(key)) unmatchedBySurface.set(key, []);
        unmatchedBySurface.get(key).push(entry);
    }
    const add = (entry, item) => {
        if (!entry || parsed.has(entry.index)) return;
        const normalized = normalizeVocabularyRow(item);
        if (!normalized.meaning || !/[가-힣]/.test(normalized.meaning)) return;
        normalized.surface = String(entry.item.surface || '').trim();
        parsed.set(entry.index, normalized);
    };
    const findBySurface = (surface) => {
        const candidates = unmatchedBySurface.get(wordbookSurfaceKey(surface)) || [];
        return candidates.find((entry) => !parsed.has(entry.index));
    };

    const section = raw.match(/\[\[VOCABULARY\]\]\s*([\s\S]*?)(?=\n?\[\[END\]\]|$)/i)?.[1] || raw;
    for (const sourceLine of section.split(/\r?\n/)) {
        const line = sourceLine.replace(/^\s*[-*•]\s*/, '').replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim();
        if (!line || !line.includes('|||')) continue;
        const fields = line.split(/\s*\|\|\|\s*/).map((field) => field.trim());
        const requestId = fields[0]?.toLocaleUpperCase();
        if (byId.has(requestId) && fields.length >= 6) {
            const [id, surface, reading = '', korean_pronunciation = '', part_of_speech = '', meaning = '', nuance = '', example = '', example_translation = ''] = fields;
            add(byId.get(id.toLocaleUpperCase()), { surface, reading, korean_pronunciation, part_of_speech, meaning, nuance, example, example_translation });
        } else if (fields.length >= 5) {
            const [surface, reading = '', korean_pronunciation = '', part_of_speech = '', meaning = '', nuance = '', example = '', example_translation = ''] = fields;
            add(findBySurface(surface), { surface, reading, korean_pronunciation, part_of_speech, meaning, nuance, example, example_translation });
        }
    }

    // JSON 등 다른 형식을 반환한 모델도 기존의 유연한 분석기로 한 번 더 회수한다.
    if (parsed.size < entries.length) {
        try {
            const payload = parseAnalysisPayload(response);
            for (const item of payload?.vocabulary || []) add(findBySurface(item.surface), item);
        } catch {
            // 행 형식에서 확보한 결과는 그대로 사용한다.
        }
    }
    return parsed;
}

function applyWordbookEnrichment(entries, parsed) {
    let changed = 0;
    const fields = ['reading', 'korean_pronunciation', 'part_of_speech', 'meaning', 'nuance', 'example', 'example_translation'];
    for (const entry of entries) {
        const target = settings.savedWords.find((item) => item === entry.item);
        const enrichment = parsed.get(entry.index);
        if (!target || !enrichment?.meaning || !/[가-힣]/.test(enrichment.meaning)) continue;
        const meaningWasMissing = !String(target.meaning || '').trim();
        for (const field of fields) {
            if (!String(target[field] || '').trim() && String(enrichment[field] || '').trim()) target[field] = String(enrichment[field]).trim();
        }
        target.key = `${target.language}:${target.surface}:${target.meaning}`;
        if (meaningWasMissing && String(target.meaning || '').trim()) changed++;
    }
    return changed;
}

function setWordbookEnrichmentBusy(busy, current = 0, total = 0) {
    const button = document.getElementById('chatlingo-fill-missing-meanings');
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? `빈 뜻 정리 중… ${current}/${total}` : '빈 뜻 자동 채우기';
}

async function fillMissingWordMeanings() {
    if (activeController) {
        toast('info', '진행 중인 분석이 끝난 뒤 다시 눌러 주세요.');
        return;
    }
    const targets = settings.savedWords
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => String(item.surface || '').trim() && !String(item.meaning || '').trim());
    if (!targets.length) {
        toast('info', '뜻이 비어 있는 단어가 없습니다.');
        return;
    }
    const batches = [];
    for (const language of ['ja', 'en']) {
        const languageEntries = targets.filter(({ item }) => item.language === language);
        for (let offset = 0; offset < languageEntries.length; offset += WORDBOOK_ENRICH_BATCH_SIZE) {
            batches.push({
                language,
                entries: languageEntries.slice(offset, offset + WORDBOOK_ENRICH_BATCH_SIZE)
                    .map((entry, index) => ({ ...entry, requestId: `W${index + 1}` })),
            });
        }
    }
    const message = `뜻이 비어 있는 단어 ${targets.length}개를 자동으로 채울까요?\n현재 선택된 분석 연결로 기본 ${batches.length}회 요청하며, 모델이 항목을 빠뜨리면 해당 항목만 한 번 더 요청합니다.\n기존 내용은 지우거나 덮어쓰지 않습니다.`;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(message)) return;

    activeController = new AbortController();
    analysisStartedAt = Date.now();
    setBusy(true, '단어장의 빈 뜻을 채우고 있어요. 채팅은 계속 사용할 수 있습니다.');
    let completed = 0;
    let failed = 0;
    try {
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            setWordbookEnrichmentBusy(true, batchIndex + 1, batches.length);
            const response = await requestAnalysis(buildWordbookEnrichmentPrompt(batch.entries, batch.language), activeController.signal);
            const parsed = parseWordbookEnrichmentResponse(response, batch.entries);
            completed += applyWordbookEnrichment(batch.entries, parsed);
            saveSettings();
            renderWordbook();
            let missing = batch.entries.filter((entry) => !parsed.has(entry.index));
            if (missing.length) {
                const retryEntries = missing.map((entry, index) => ({ ...entry, requestId: `W${index + 1}` }));
                const retryResponse = await requestAnalysis(buildWordbookEnrichmentPrompt(retryEntries, batch.language, true), activeController.signal);
                const retried = parseWordbookEnrichmentResponse(retryResponse, retryEntries);
                completed += applyWordbookEnrichment(retryEntries, retried);
                saveSettings();
                renderWordbook();
                missing = retryEntries.filter((entry) => !retried.has(entry.index));
            }
            failed += missing.length;
        }
        if (failed) toast('warning', `${completed}개 뜻을 채웠고 ${failed}개는 모델 응답에서 뜻을 찾지 못했습니다. 다시 누르면 남은 단어만 재시도합니다.`);
        else toast('success', `뜻이 비어 있던 단어 ${completed}개를 모두 정리했습니다.`);
    } catch (error) {
        if (isAbortError(error) && activeController?.signal.aborted) toast('info', '빈 뜻 자동 정리를 취소했습니다.');
        else {
            console.error('[ChatLingo] Wordbook enrichment failed:', error);
            toast('error', `빈 뜻 자동 정리를 중단했습니다: ${readableErrorMessage(error)}`);
        }
    } finally {
        activeController = null;
        analysisStartedAt = 0;
        setWordbookEnrichmentBusy(false);
        setBusy(false);
    }
}

function changeWordbookPage(step) {
    wordbookView.page += step;
    renderWordbook();
}

function savedWordEditMarkup(item, index) {
    const input = (label, field, value = '') => `<label><span>${label}</span><input data-edit-field="${field}" value="${escapeHtml(value)}"></label>`;
    const textarea = (label, field, value = '') => `<label class="chatlingo-saved-edit-wide"><span>${label}</span><textarea data-edit-field="${field}" rows="2">${escapeHtml(value)}</textarea></label>`;
    return `<div class="chatlingo-saved-word is-editing"><div class="chatlingo-saved-edit" data-saved-edit="${index}">
        ${input('표기', 'surface', item.surface)}
        ${input('읽기', 'reading', item.reading)}
        ${input('한글 발음', 'korean_pronunciation', item.korean_pronunciation)}
        ${input('품사', 'part_of_speech', item.part_of_speech)}
        ${textarea('뜻', 'meaning', item.meaning)}
        ${textarea('뉘앙스', 'nuance', item.nuance)}
        ${textarea('예문', 'example', item.example)}
        ${textarea('예문 번역', 'example_translation', item.example_translation)}
        <div class="chatlingo-saved-edit-actions"><button data-action="cancel-saved-edit">취소</button><button data-action="save-saved-edit" data-edit-index="${index}">저장</button></div>
    </div></div>`;
}

function renderWordbook() {
    const count = document.getElementById('chatlingo-word-count');
    const container = document.getElementById('chatlingo-wordbook');
    if (count) count.textContent = settings.savedWords.length;
    if (!container) return;
    if (!settings.savedWords.length) {
        container.innerHTML = '<p class="chatlingo-wordbook-empty">분석 결과에서 ‘저장’을 누르면 여기에 추가돼요.</p>';
        return;
    }
    let entries = settings.savedWords.map((item, index) => ({ item, index }));
    if (wordbookView.language !== 'all') entries = entries.filter(({ item }) => item.language === wordbookView.language);
    entries.sort((left, right) => {
        if (wordbookView.sort === 'oldest') return String(left.item.savedAt || '').localeCompare(String(right.item.savedAt || ''));
        if (wordbookView.sort === 'alphabetical') return String(left.item.surface || '').localeCompare(String(right.item.surface || ''), ['ko', 'ja', 'en'], { sensitivity: 'base', numeric: true });
        return String(right.item.savedAt || '').localeCompare(String(left.item.savedAt || ''));
    });
    const pageCount = Math.max(1, Math.ceil(entries.length / WORDBOOK_PAGE_SIZE));
    wordbookView.page = Math.min(pageCount, Math.max(1, wordbookView.page));
    const pageEntries = entries.slice((wordbookView.page - 1) * WORDBOOK_PAGE_SIZE, wordbookView.page * WORDBOOK_PAGE_SIZE);
    const words = pageEntries.map(({ item, index }) => editingSavedWordIndex === index ? savedWordEditMarkup(item, index) : `<div class="chatlingo-saved-word">
        <label class="chatlingo-saved-select"><input type="checkbox" data-saved-select="${index}" aria-label="${escapeHtml(item.surface)} 선택"></label>
        <div class="chatlingo-saved-content"><div class="chatlingo-saved-title"><strong>${escapeHtml(item.surface)}</strong></div><small>${escapeHtml(item.korean_pronunciation || item.reading || '')}</small><span>${escapeHtml(item.meaning)}</span></div>
        <div class="chatlingo-saved-actions"><button data-edit-word="${index}">수정</button><button data-speak="${escapeHtml(item.surface)}" data-lang="${item.language}">음성</button><button data-remove-word="${index}">삭제</button></div>
    </div>`).join('');
    container.innerHTML = `<div class="chatlingo-wordbook-tools">
        <select id="chatlingo-wordbook-language" aria-label="언어 필터"><option value="all" ${wordbookView.language === 'all' ? 'selected' : ''}>전체 언어</option><option value="ja" ${wordbookView.language === 'ja' ? 'selected' : ''}>일본어</option><option value="en" ${wordbookView.language === 'en' ? 'selected' : ''}>영어</option></select>
        <select id="chatlingo-wordbook-sort" aria-label="정렬"><option value="newest" ${wordbookView.sort === 'newest' ? 'selected' : ''}>최신순</option><option value="oldest" ${wordbookView.sort === 'oldest' ? 'selected' : ''}>오래된순</option><option value="alphabetical" ${wordbookView.sort === 'alphabetical' ? 'selected' : ''}>가나다·ABC·あいう 순</option></select>
        <label><input id="chatlingo-saved-select-all" type="checkbox"> 현재 페이지 전체</label><button data-action="delete-saved-selected">선택 삭제</button>
    </div>${words || '<p class="chatlingo-wordbook-empty">이 조건에 맞는 단어가 없습니다.</p>'}<div class="chatlingo-wordbook-pagination"><button data-action="wordbook-prev" ${wordbookView.page <= 1 ? 'disabled' : ''}>이전</button><span>${wordbookView.page} / ${pageCount} · ${entries.length}개</span><button data-action="wordbook-next" ${wordbookView.page >= pageCount ? 'disabled' : ''}>다음</button></div>`;
}

function downloadFile(content, type, fileName) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: globalThis }));
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportWordbookBackup() {
    if (!settings.savedWords.length) {
        toast('info', '내보낼 단어가 없습니다.');
        return;
    }
    const backup = {
        format: 'chatlingo-wordbook',
        version: 1,
        exportedAt: new Date().toISOString(),
        words: settings.savedWords,
    };
    downloadFile(JSON.stringify(backup, null, 2), 'application/json;charset=utf-8', `chatlingo-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast('success', '챗링고 백업 파일을 저장했습니다.');
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            if (character === '"' && source[index + 1] === '"') {
                cell += '"';
                index++;
            } else if (character === '"') quoted = false;
            else cell += character;
        } else if (character === '"') quoted = true;
        else if (character === ',') {
            row.push(cell);
            cell = '';
        } else if (character === '\n') {
            row.push(cell.replace(/\r$/, ''));
            if (row.some((value) => value.trim())) rows.push(row);
            row = [];
            cell = '';
        } else cell += character;
    }
    row.push(cell.replace(/\r$/, ''));
    if (row.some((value) => value.trim())) rows.push(row);
    return rows;
}

function normalizeImportedWord(raw) {
    const surface = String(raw?.surface || '').trim();
    const meaning = String(raw?.meaning || '').trim();
    if (!surface) return null;
    const language = inferWordLanguage(surface, raw.language);
    return {
        surface,
        meaning,
        language,
        reading: String(raw.reading || ''),
        korean_pronunciation: String(raw.korean_pronunciation || ''),
        part_of_speech: String(raw.part_of_speech || ''),
        nuance: String(raw.nuance || ''),
        example: String(raw.example || ''),
        example_translation: String(raw.example_translation || ''),
        savedAt: String(raw.savedAt || new Date().toISOString()),
        key: `${language}:${surface}:${meaning}`,
    };
}

async function importWordbook(file) {
    if (!file) return;
    try {
        const text = await file.text();
        let sourceWords = [];
        if (file.name.toLowerCase().endsWith('.json') || file.type.includes('json')) {
            const parsed = JSON.parse(text);
            sourceWords = Array.isArray(parsed) ? parsed : parsed.words;
        } else {
            const rows = parseCsv(text);
            const headers = rows.shift() || [];
            const headerMap = {
                '언어': 'language', '표현': 'surface', '읽기': 'reading', '한글 발음': 'korean_pronunciation',
                '품사': 'part_of_speech', '뜻': 'meaning', '뉘앙스': 'nuance', '예문': 'example',
                '예문 번역': 'example_translation', '저장일': 'savedAt',
            };
            const keys = headers.map((header) => headerMap[header.trim()] || header.trim());
            sourceWords = rows.map((values) => Object.fromEntries(keys.map((key, index) => [key, values[index] || ''])));
        }
        if (!Array.isArray(sourceWords)) throw new Error('단어 목록을 찾지 못했습니다.');
        const imported = sourceWords.map(normalizeImportedWord).filter(Boolean);
        const existingKeys = new Set(settings.savedWords.map((word) => word.key || `${word.language}:${word.surface}:${word.meaning}`));
        const newWords = imported.filter((word) => {
            if (existingKeys.has(word.key)) return false;
            existingKeys.add(word.key);
            return true;
        });
        settings.savedWords = [...newWords, ...settings.savedWords].slice(0, MAX_SAVED_WORDS);
        saveSettings();
        renderWordbook();
        toast('success', `${newWords.length}개를 가져왔습니다.${imported.length - newWords.length ? ` 중복 ${imported.length - newWords.length}개는 제외했습니다.` : ''}`);
    } catch (error) {
        console.error('[ChatLingo] Wordbook import failed:', error);
        toast('error', `단어장을 가져오지 못했습니다: ${error.message}`);
    }
}

function legacyCopyText(text) {
    const textarea = document.createElement('textarea');
    const activeElement = document.activeElement;
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    Object.assign(textarea.style, {
        position: 'fixed',
        inset: '0 auto auto 0',
        width: '1px',
        height: '1px',
        padding: '0',
        border: '0',
        opacity: '0',
        fontSize: '16px',
    });
    document.body.append(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
        copied = Boolean(document.execCommand?.('copy'));
    } catch {
        copied = false;
    }
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
    return copied;
}

async function writeClipboardText(text) {
    if (legacyCopyText(text)) return;
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    throw new Error('이 브라우저에서는 클립보드 복사를 사용할 수 없습니다.');
}

async function copyResult() {
    if (!lastAnalysis) return;
    const lines = [
        stripAnnotations(lastAnalysis.annotated), lastAnalysis.pronunciation,
        lastAnalysis.translation, '', lastAnalysis.context_note, '',
        lastAnalysis.grammar.length ? '[표현 · 문법]' : '',
        ...lastAnalysis.grammar.map((item) => `${item.pattern} — ${item.explanation}`),
        lastAnalysis.vocabulary.length ? '\n[핵심 단어 · 표현]' : '',
        ...lastAnalysis.vocabulary.flatMap((item) => [
            `${item.surface}${item.korean_pronunciation || item.reading ? ` · ${item.korean_pronunciation || item.reading}` : ''} — ${item.meaning}`,
            item.nuance ? `  ${item.nuance}` : '',
            item.example ? `  예문: ${item.example}${item.example_translation ? ` — ${item.example_translation}` : ''}` : '',
        ]),
    ].filter(Boolean);
    try {
        await writeClipboardText(lines.join('\n'));
        toast('success', '학습 내용을 복사했습니다.');
    } catch (error) {
        console.error('[ChatLingo] Copy failed:', error);
        toast('error', '복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.');
    }
}

async function populateProfiles() {
    const select = document.getElementById('chatlingo-profile');
    if (!select) return;
    select.innerHTML = '<option value="">메인 API · 현재 모델</option>';
    try {
        const service = await loadProfileService();
        const profiles = service?.getSupportedProfiles?.() || [];
        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = `${profile.name || '이름 없는 프로필'} · ${profile.model || profile.api}`;
            select.append(option);
        }
        if (profiles.some((profile) => profile.id === settings.connectionProfileId)) {
            select.value = settings.connectionProfileId;
        } else if (settings.connectionProfileId) {
            settings.connectionProfileId = '';
            saveSettings();
        }
    } catch (error) {
        console.info('[ChatLingo] Main API mode only:', error);
    }
}

function bindEvents() {
    const panel = document.getElementById(PANEL_ID);
    document.addEventListener('selectionchange', rememberSelection);
    document.addEventListener('pointerup', rememberSelection, true);
    document.addEventListener('touchend', rememberSelection, true);
    document.addEventListener('click', (event) => {
        if (event.target.closest('#chatlingo-menu-item, #chatlingo-fallback-launcher')) openPanel();
    });
    document.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('#chatlingo-menu-item, #chatlingo-fallback-launcher')) openPanel();
    });
    panel.addEventListener('click', (event) => {
        const target = event.target.closest('button');
        if (!target) return;
        const { action, language, speak: speechText, lang, saveWord: saveIndex, removeWord: removeIndex, editWord: editIndex } = target.dataset;
        if (language) setLanguage(language);
        if (speechText) speak(speechText, lang, target);
        if (saveIndex !== undefined) saveWord(Number(saveIndex));
        if (removeIndex !== undefined) removeWord(Number(removeIndex));
        if (editIndex !== undefined) beginSavedWordEdit(Number(editIndex));
        const actions = {
            close: closePanel, collapse: togglePanelCollapsed, selection: copySelection, latest: copyLatest,
            clear: () => { document.getElementById('chatlingo-input').value = ''; updateCount(); },
            analyze,
            'export-backup': exportWordbookBackup,
            'import-wordbook': () => document.getElementById('chatlingo-import-file').click(),
            'copy-result': copyResult,
            'clear-result': clearAnalysisResult,
            'save-selected': saveSelectedWords,
            'delete-saved-selected': deleteSelectedSavedWords,
            'cancel-saved-edit': cancelSavedWordEdit,
            'save-saved-edit': () => saveSavedWordEdit(Number(target.dataset.editIndex)),
            'fill-missing-meanings': fillMissingWordMeanings,
            'merge-duplicates': mergeDuplicateWords,
            'focus-wordbook': () => setWordbookFocus(true),
            'close-wordbook-focus': () => setWordbookFocus(false),
            'wordbook-prev': () => changeWordbookPage(-1),
            'wordbook-next': () => changeWordbookPage(1),
        };
        actions[action]?.();
    });
    panel.addEventListener('change', (event) => {
        if (event.target.id === 'chatlingo-wordbook-language') {
            wordbookView.language = event.target.value;
            wordbookView.page = 1;
            renderWordbook();
            return;
        }
        if (event.target.id === 'chatlingo-wordbook-sort') {
            wordbookView.sort = event.target.value;
            wordbookView.page = 1;
            renderWordbook();
            return;
        }
        if (event.target.id === 'chatlingo-saved-select-all') {
            panel.querySelectorAll('[data-saved-select]').forEach((input) => { input.checked = event.target.checked; });
            return;
        }
        if (event.target.id === 'chatlingo-select-all') {
            panel.querySelectorAll('[data-word-select]').forEach((input) => { input.checked = event.target.checked; });
            return;
        }
        if (event.target.matches('[data-word-select]')) {
            const all = [...panel.querySelectorAll('[data-word-select]')];
            const master = document.getElementById('chatlingo-select-all');
            if (master) {
                master.checked = all.every((input) => input.checked);
                master.indeterminate = !master.checked && all.some((input) => input.checked);
            }
        }
    });
    document.getElementById('chatlingo-import-file').addEventListener('change', async (event) => {
        await importWordbook(event.target.files?.[0]);
        event.target.value = '';
    });
    document.getElementById('chatlingo-input').addEventListener('input', updateCount);
    document.getElementById('chatlingo-profile').addEventListener('change', (event) => {
        settings.connectionProfileId = event.target.value;
        saveSettings();
    });
    document.getElementById('chatlingo-max-tokens').addEventListener('change', (event) => {
        settings.maxTokens = normalizeMaxTokens(event.target.value);
        event.target.value = String(settings.maxTokens);
        saveSettings();
    });
    document.getElementById('chatlingo-context-count').addEventListener('change', (event) => {
        settings.contextMessageCount = Number(event.target.value);
        updateContextHelp();
        saveSettings();
    });
    document.getElementById('chatlingo-latest-mode').addEventListener('change', (event) => {
        settings.latestImportMode = event.target.value === 'all' ? 'all' : 'dialogue';
        saveSettings();
    });
    document.getElementById('chatlingo-tts-source').addEventListener('change', (event) => {
        stopSpeech();
        settings.ttsSource = event.target.value === 'sillytavern' ? 'sillytavern' : 'browser';
        updateTtsSourceUi();
        saveSettings();
    });
    document.getElementById('chatlingo-voice-ja').addEventListener('change', (event) => {
        settings.ttsVoiceJa = event.target.value;
        saveSettings();
    });
    document.getElementById('chatlingo-voice-en').addEventListener('change', (event) => {
        settings.ttsVoiceEn = event.target.value;
        saveSettings();
    });
    document.getElementById('chatlingo-rate').addEventListener('input', (event) => {
        settings.ttsRate = Number(event.target.value);
        document.getElementById('chatlingo-rate-value').textContent = `${settings.ttsRate.toFixed(2)}×`;
        saveSettings();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.getElementById(PANEL_ID)?.classList.contains('is-open')) closePanel();
    });
    globalThis.addEventListener('resize', applyResponsivePanelLayout, { passive: true });
    globalThis.visualViewport?.addEventListener?.('resize', applyResponsivePanelLayout, { passive: true });
}

async function init() {
    const context = getContext();
    const savedSettings = context.extensionSettings[MODULE_ID] || {};
    settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    if (!savedSettings.settingsVersion && Number(savedSettings.maxTokens) <= 2800) {
        settings.maxTokens = DEFAULT_MAX_TOKENS;
    }
    settings.maxTokens = normalizeMaxTokens(settings.maxTokens);
    // v3까지의 기본값(최근 4개)을 v4의 새 기본값(사용 안 함)으로 한 번만 옮긴다.
    // 이미 사용 안 함을 선택했거나 새 설치인 경우에도 0을 유지한다.
    if (Number(savedSettings.settingsVersion || 0) < 4 && Number(savedSettings.contextMessageCount ?? 4) === 4) {
        settings.contextMessageCount = 0;
    }
    if (Number(savedSettings.settingsVersion || 0) < 5 && Number(savedSettings.maxTokens ?? 4096) === 4096) {
        settings.maxTokens = DEFAULT_MAX_TOKENS;
    }
    if (![0, 2, 4, 6].includes(Number(settings.contextMessageCount))) settings.contextMessageCount = 0;
    if (!['dialogue', 'all'].includes(settings.latestImportMode)) settings.latestImportMode = 'dialogue';
    if (!['browser', 'sillytavern'].includes(settings.ttsSource)) settings.ttsSource = 'browser';
    settings.settingsVersion = SETTINGS_VERSION;
    if (!Array.isArray(settings.savedWords)) settings.savedWords = [];
    context.extensionSettings[MODULE_ID] = settings;

    document.body.insertAdjacentHTML('beforeend', panelMarkup());
    document.body.insertAdjacentHTML('beforeend', `<button id="chatlingo-fallback-launcher" class="chatlingo-fallback-launcher" title="챗링고 열기" aria-label="챗링고 열기" hidden>Aあ</button>`);
    installHamburgerMenuItem();
    setTimeout(() => {
        installHamburgerMenuItem();
        updateFallbackLauncher();
    }, 1200);
    document.getElementById('chatlingo-max-tokens').value = String(settings.maxTokens);
    document.getElementById('chatlingo-context-count').value = String(settings.contextMessageCount);
    document.getElementById('chatlingo-latest-mode').value = settings.latestImportMode;
    document.getElementById('chatlingo-tts-source').value = settings.ttsSource;
    document.getElementById('chatlingo-rate').value = String(settings.ttsRate);
    document.getElementById('chatlingo-rate-value').textContent = `${Number(settings.ttsRate).toFixed(2)}×`;
    bindEvents();
    setLanguage(settings.language);
    updateContextHelp();
    renderWordbook();
    refreshVoices();
    updateTtsSourceUi();
    globalThis.speechSynthesis?.addEventListener?.('voiceschanged', refreshVoices);
    await populateProfiles();
    saveSettings();
    console.info('[ChatLingo] 챗링고가 준비되었습니다.');
}

globalThis.jQuery?.(async () => {
    try {
        await init();
    } catch (error) {
        console.error('[ChatLingo] 초기화 실패:', error);
    }
});
