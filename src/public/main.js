  // ── SCROLL REVEAL ──────────────────────────────────────────────────────
  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('visible'), i * 60);
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });
  reveals.forEach(el => observer.observe(el));

  // ── COPY BUTTONS ───────────────────────────────────────────────────────
  function copyCmd(btn, text) {
    const setCopied = () => {
      const orig = btn.textContent;
      btn.textContent = 'copied!';
      btn.style.color = 'var(--green)';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
    };

    const fallbackCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(ta);
      if (ok) setCopied();
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(setCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  // ── MOBILE NAV ────────────────────────────────────────────────────────
  const navToggle = document.querySelector('.nav-toggle');
  const navDrawer = document.getElementById('navMenu');

  function setNavOpen(open) {
    if (!navToggle || !navDrawer) return;
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    navDrawer.classList.toggle('open', open);
  }

  if (navToggle && navDrawer) {
    navToggle.addEventListener('click', () => {
      const isOpen = navDrawer.classList.contains('open');
      setNavOpen(!isOpen);
    });

    navDrawer.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a) setNavOpen(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setNavOpen(false);
    });

    document.addEventListener('click', (e) => {
      if (!navDrawer.classList.contains('open')) return;
      const inside = e.target.closest('nav');
      if (!inside) setNavOpen(false);
    });
  }

  // ── SECURITY SECTION TABS ─────────────────────────────────────────────
  const securityTabs = Array.from(document.querySelectorAll('[data-security-tab]'));
  const securityPanels = Array.from(document.querySelectorAll('[data-security-panel]'));

  function setSecurityPanel(panelId) {
    if (securityTabs.length === 0 || securityPanels.length === 0) return;
    securityTabs.forEach((tab) => {
      const active = tab.dataset.securityTab === panelId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    securityPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.securityPanel === panelId);
    });
  }

  securityTabs.forEach((tab) => {
    tab.addEventListener('click', () => setSecurityPanel(tab.dataset.securityTab));
  });

  if (securityTabs.length && securityPanels.length) {
    setSecurityPanel(securityTabs[0].dataset.securityTab);
  }

  // ── TYPEWRITER TERMINAL ────────────────────────────────────────────────
  // Each entry: [cssClass, text, delayAfter_ms]
  // cssClass '' = blank line
  const LINES = [
    ['t-comment', '# Kill-switch persists across restarts; reset memory first', 0],
    ['', '', 200],
    ['t-prompt-line', '1', 300],
    ['t-dim', '[INFO] Processing normal transaction...', 60],
    ['t-dim', '------------------------------------', 0],
    ['t-light', 'Normal TX', 0],
    ['t-err',  'Decision : BLOCKED', 0],
    ['t-err',  'Layer    : KILL_SWITCH', 0],
    ['t-err',  'Reason   : Kill-switch engaged', 0],
    ['t-dim',  '------------------------------------', 0],
    ['', '', 400],
    ['t-prompt-line', '6', 300],
    ['t-out', '[INFO] In-memory agent state reset', 0],
    ['', '', 400],
    ['t-comment', '# Normal transaction — LOW risk, auto-approved', 0],
    ['', '', 200],
    ['t-prompt-line', '1', 300],
    ['t-dim', '[INFO] Processing normal transaction...', 60],
    ['t-dim', '------------------------------------', 0],
    ['t-light', 'Normal TX', 0],
    ['t-out',  'Decision : EXECUTED', 0],
    ['t-out',  'Layer    : EXECUTION', 0],
    ['t-out',  'OK       : true', 0],
    ['t-out',  'Digest   : D6gKSC1uNz5aEmD3q7c48cs6YrXzw3phWMfkG2PyjfAS', 0],
    ['t-info', 'Explorer : https://suiscan.xyz/testnet/tx/D6gKSC1...', 0],
    ['t-dim',  '------------------------------------', 0],
    ['', '', 600],
    ['t-comment', '# OS attack -> cross-domain blockchain freeze', 0],
    ['', '', 200],
    ['t-prompt-line', '4', 300],
    ['t-dim', '[INFO] Simulating destructive OS command...', 60],
    ['t-dim', '------------------------------------', 0],
    ['t-light', 'OS Attack', 0],
    ['t-err',  'Decision : BLOCKED', 0],
    ['t-err',  'Layer    : FIREWALL', 0],
    ['t-err',  'Reason   : Destructive OS command blocked', 0],
    ['t-dim',  '------------------------------------', 0],
    ['', '', 500],
    ['t-comment', '# Blockchain now frozen cross-domain after OS violation', 0],
    ['', '', 200],
    ['t-prompt-line', '2', 300],
    ['t-dim', '[INFO] Processing medium risk transaction...', 60],
    ['t-dim', '[INFO] Watch Telegram for MEDIUM alert', 60],
    ['t-dim', '------------------------------------', 0],
    ['t-light', 'Medium Risk TX', 0],
    ['t-err',  'Decision : BLOCKED', 0],
    ['t-err',  'Layer    : KILL_SWITCH', 0],
    ['t-err',  'Reason   : Kill-switch engaged', 0],
    ['t-dim',  '------------------------------------', 0],
    ['', '', 400],
    ['t-comment', '# Show recent OS + on-chain logs', 0],
    ['', '', 200],
    ['t-prompt-line', '7', 250],
    ['t-dim', '[INFO] Recent OS Security Logs...', 80],
    ['t-dim', '[INFO] Recent On-Chain Execution Logs...', 80],
    ['', '', 200],
    ['t-cursor-line', '', 0],
  ];

  const terminal = document.getElementById('mainTerminal');

  function makeLine(cls, text) {
    const span = document.createElement('span');
    span.className = 't-line';

    if (cls === 't-prompt-line') {
      span.innerHTML = `<span class="t-prompt">clawall&gt;</span> <span class="t-cmd">${text}</span>`;
    } else if (cls === 't-cursor-line') {
      span.innerHTML = `<span class="t-prompt">clawall&gt;</span> <span class="cursor"></span>`;
    } else if (cls === '') {
      span.innerHTML = '&nbsp;';
    } else {
      span.className += ` ${cls}`;
      span.textContent = text;
    }

    // fade-in each line
    span.style.opacity = '0';
    span.style.transition = 'opacity 0.25s ease';
    return span;
  }

  async function runTypewriter() {
    // base delay so terminal is in viewport
    await new Promise(r => setTimeout(r, 600));

    for (const [cls, text, pause] of LINES) {
      const line = makeLine(cls, text);
      terminal.appendChild(line);
      // trigger reflow then fade in
      requestAnimationFrame(() => { line.style.opacity = '1'; });
      terminal.scrollTop = terminal.scrollHeight;

      const wait = pause > 0 ? pause : 55;
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // Only run when terminal scrolls into view
  const termObs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      termObs.disconnect();
      runTypewriter();
    }
  }, { threshold: 0.3 });

  termObs.observe(document.querySelector('.terminal-wrap'));
