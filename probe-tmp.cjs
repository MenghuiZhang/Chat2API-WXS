function puzzleProbeScript() {
    return `
    (async () => {
      const vis = (el) => {
        if (!el) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 5 || b.height < 5) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };

      // --- Background candidates: landscape img/canvas --------------------
      const bgCands = Array.from(document.querySelectorAll('img, canvas')).filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width >= 120 && b.height >= 60 && (b.width / b.height) > 1.4 && vis(el);
      });
      if (!bgCands.length) return { error: 'no-bg' };

      // --- 1. Known selectors ---------------------------------------------
      const handleSelectors = [
        '.nc-lang-cnt [class*="btn_slide"]',
        '[class*="slidetounlock"] [class*="btn"]',
        '.btn_slide',
        '[id^="nc_"][id$="_n1z"]',
        '.nc_iconfont.btn_slide',
        '[class*="slide-btn"]',
        '[class*="slider-btn"]',
        '[class*="slide_btn"]',
        '[class*="btn-slide"]',
        '[class*="drag"]',
      ];
      let handle = null;
      let how = 'selector';
      for (const s of handleSelectors) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(s)); } catch (e) { els = []; }
        for (const el of els) { if (vis(el)) { handle = el; break; } }
        if (handle) break;
      }

      // --- 2. Text scan: the hint line sits inside / next to the track ----
      if (!handle && document.body) {
        how = 'text';
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.nodeValue || '').trim();
          if (!t || t.length > 40) continue;
          if (!/拖动滑块|滑动完成|向右滑动|drag.*slider|slide.*complete|slide.*verify/i.test(t)) continue;
          let el = node.parentElement;
          for (let up = 0; up < 5 && el; up++) {
            const b = el.getBoundingClientRect();
            if (b.width > 120 && b.height >= 24 && b.height <= 90) {
              const kids = Array.from(el.querySelectorAll('*')).filter((c) => {
                const cb = c.getBoundingClientRect();
                return cb.width >= 18 && cb.width <= 90 && cb.height >= 18 && cb.height <= 90 && vis(c);
              });
              if (kids.length) {
                kids.sort((a, b2) => a.getBoundingClientRect().x - b2.getBoundingClientRect().x);
                handle = kids[0];
                break;
              }
            }
            el = el.parentElement;
          }
          if (handle) break;
        }
      }

      // --- 3. Structural scan near the background: square knob in a bar ---
      if (!handle) {
        how = 'structure';
        const bgRects = bgCands.map((el) => el.getBoundingClientRect());
        const near = (b) => bgRects.some((r) => {
          const dy = Math.max(r.top - b.bottom, b.top - r.bottom, 0);
          const dx = Math.max(r.left - b.right, b.left - r.right, 0);
          return dy < 350 && dx < 200;
        });
        const bars = Array.from(document.querySelectorAll('div,section,span')).filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 150 && b.height >= 26 && b.height <= 70 && (b.width / b.height) > 3 && vis(el) && near(b);
        });
        for (const bar of bars) {
          const kids = Array.from(bar.querySelectorAll('*')).filter((c) => {
            const cb = c.getBoundingClientRect();
            const ratio = cb.width / Math.max(1, cb.height);
            return cb.width >= 18 && cb.width <= 80 && ratio > 0.6 && ratio < 1.7 && vis(c);
          });
          if (kids.length) {
            kids.sort((a, b2) => a.getBoundingClientRect().x - b2.getBoundingClientRect().x);
            handle = kids[0];
            break;
          }
        }
      }
      if (!handle) return { error: 'no-handle', bgFound: bgCands.length };

      const hb = handle.getBoundingClientRect();
      const dist = (el) => {
        const b = el.getBoundingClientRect();
        const dx = Math.max(b.left - hb.right, hb.left - b.right, 0);
        const dy = Math.max(b.top - hb.bottom, hb.top - b.bottom, 0);
        return Math.hypot(dx, dy);
      };
      bgCands.sort((a, b) => dist(a) - dist(b));
      const bg = bgCands[0];
      const bgb = bg.getBoundingClientRect();

      const track =
        handle.closest('.slidetounlock, .nc-lang-cnt, [class*="track"], [class*="slider"]') ||
        handle.parentElement;
      const tb = track ? track.getBoundingClientRect() : bgb;

      // --- Movable puzzle piece (separate element riding on the bg) --------
      // Used both as the 'slide' disambiguation image (so the recognizer
      // locks onto the gap silhouette instead of the piece itself) and, via
      // its CURRENT center, to compute the exact drag delta — after a failed
      // attempt the piece does not snap back to the track start.
      const pieceBandTop = bgb.top + bgb.height * 0.15;
      const pieceBandBottom = bgb.bottom - bgb.height * 0.15;
      const pieceCands = Array.from(document.querySelectorAll('img, canvas, div, span')).filter((el) => {
        if (el === bg) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 10 || b.width > 140 || b.height < 10 || b.height > 140) return false;
        if (!vis(el)) return false;
        const cy = b.top + b.height / 2;
        if (cy < pieceBandTop || cy > pieceBandBottom) return false;
        if (b.right < bgb.left - 30 || b.left > bgb.right + 30) return false;
        if (el.tagName !== 'IMG' && el.tagName !== 'CANVAS') {
          const bi = getComputedStyle(el).backgroundImage || '';
          // NOTE: this is inside a template string; backslashes get cooked,
          // so regex escapes must be doubled (\\( -> \() or the whole probe
          // script fails with SyntaxError in the page.
          if (!/url\\(/.test(bi)) return false;
        }
        return true;
      });
      // The movable piece starts at the LEFT edge while the gap silhouette
      // sits wherever the puzzle placed it, so the leftmost sprite is the
      // piece (smallest-area picking could grab the gap overlay instead and
      // collapse the drag distance to ~0).
      pieceCands.sort((a, b2) => a.getBoundingClientRect().x - b2.getBoundingClientRect().x);
      const piece = pieceCands[0] || null;
      const pieceRect = piece ? piece.getBoundingClientRect() : null;

      // --- Refresh button (small square at the bg top-right corner) --------
      let refreshRect = null;
      const refreshCands = Array.from(document.querySelectorAll('img, canvas, div, span, button, i, svg, a')).filter((el) => {
        const b = el.getBoundingClientRect();
        if (b.width < 12 || b.width > 60 || b.height < 12 || b.height > 60) return false;
        if (!vis(el)) return false;
        return b.right > bgb.right - 50 && b.left < bgb.right + 25 && b.top < bgb.top + 50 && b.bottom > bgb.top - 15;
      });
      refreshCands.sort((a, b2) => {
        const ra = a.getBoundingClientRect();
        const rb = b2.getBoundingClientRect();
        const da = Math.hypot(bgb.right - ra.right, ra.top - bgb.top);
        const db = Math.hypot(bgb.right - rb.right, rb.top - bgb.top);
        return da - db;
      });
      if (refreshCands[0]) refreshRect = refreshCands[0].getBoundingClientRect();

      // --- Failure banner ("验证失败，请重试") below the bg -----------------
      let failed = false;
      if (document.body) {
        const fw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let fn;
        while ((fn = fw.nextNode())) {
          const ft = (fn.nodeValue || '').trim();
          if (!ft || ft.length > 30) continue;
          if (!/验证失败|请重试|失败.*重试|retry/i.test(ft)) continue;
          const fr = fn.parentElement ? fn.parentElement.getBoundingClientRect() : null;
          if (fr && Math.abs(fr.top - bgb.bottom) < 300) { failed = true; break; }
        }
      }

      // --- Image extraction with fallbacks ---------------------------------
      // Geepass requires width/height within [50, 1024]; downscale (or
      // upscale tiny pieces) to fit and report the SUBMITTED width so the
      // main process can scale coordinates back.
      const MAXD = 1024, MIND = 50;
      const fitScale = (w, h) => {
        let s = Math.min(MAXD / w, MAXD / h, 1);
        const sMin = Math.max(MIND / w, MIND / h);
        if (s < sMin) s = sMin;
        return s;
      };
      const draw = (el, natW, natH, s) => {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(natW * s));
        c.height = Math.max(1, Math.round(natH * s));
        const ctx = c.getContext('2d');
        ctx.drawImage(el, 0, 0, c.width, c.height);
        // Some Linux builds return ZEROED pixels from getImageData while
        // toDataURL still encodes the real image (or vice versa). Sampling
        // is only a SUSPICION flag now; the main process re-checks the
        // encoded PNG with nativeImage before discarding it.
        let blank = false;
        try {
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const seen = new Set();
          const step = Math.max(1, Math.floor(d.length / 16384)) * 4;
          for (let i = 0; i + 3 < d.length; i += step) {
            seen.add((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
            if (seen.size > 8) break;
          }
          blank = seen.size < 3;
        } catch (e) { /* tainted: toDataURL below throws anyway */ }
        return { b64: c.toDataURL('image/png').split(',')[1] || '', blank };
      };
      // Fallback when drawImage throws (tainted canvas) or yields nothing:
      // hand the ORIGINAL bytes over; the main process then decodes the real
      // pixel width from the image header and scales coordinates itself.
      const grabBytes = async (el) => {
        // IMG src or, for div/span pieces, the CSS background-image url.
        // Regex backslashes are doubled because this lives inside a template
        // string where \( gets cooked into ( -> /url(/ would be an
        // unterminated group and crash the whole probe script in the page.
        const src =
          el.tagName === 'IMG'
            ? (el.currentSrc || el.src || '')
            : ((/url\\(["']?(.*?)["']?\\)/.exec(getComputedStyle(el).backgroundImage || '') || [])[1] || '');
        if (src.startsWith('data:')) {
          const i = src.indexOf(',');
          if (i > 0) return { b64: src.slice(i + 1), via: 'dataurl' };
        } else if (/^https?:/.test(src)) {
          try {
            const resp = await fetch(src, { credentials: 'include' });
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              let bin = '';
              const u8 = new Uint8Array(buf);
              for (let i = 0; i < u8.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
              }
              return { b64: btoa(bin), via: 'fetch' };
            }
          } catch (e) { /* cors; fall through */ }
        }
        return { b64: '', via: 'none' };
      };
      const grab = async (el, natW, natH, s) => {
        let b64 = '';
        let blank = false;
        try { const r = draw(el, natW, natH, s); b64 = r.b64; blank = r.blank; } catch (e) { b64 = ''; }
        if (b64 && b64.length > 100) {
          // Pixels looked blank: KEEP the canvas PNG (it may still be good)
          // but also capture the original bytes so the main process can
          // switch if nativeImage confirms the blankness.
          let alt = '';
          let altVia = '';
          if (blank) {
            const a = await grabBytes(el);
            if (a.b64.length > 100) { alt = a.b64; altVia = a.via; }
          }
          return { b64, w: Math.max(1, Math.round(natW * s)), via: 'canvas', blank, alt, altVia };
        }
        const a = await grabBytes(el);
        return { b64: a.b64, w: 0, via: a.via, blank: false, alt: '', altVia: '' };
      };

      const natW = bg.tagName === 'CANVAS' ? bg.width : (bg.naturalWidth || Math.round(bgb.width));
      const natH = bg.tagName === 'CANVAS' ? bg.height : (bg.naturalHeight || Math.round(bgb.height));
      const g = await grab(bg, natW, natH, fitScale(natW, natH));
      if (!g.b64 || g.b64.length < 100) {
        return { error: 'bg-extract-failed', handleFound: how, bgTag: bg.tagName, bgSrc: String(bg.src || '').slice(0, 120) };
      }

      // The movable piece sprite doubles as the 'slide' disambiguation image
      // so the recognizer locks onto the gap silhouette instead of the piece.
      let slideImage = '';
      if (piece) {
        const pw = piece.tagName === 'CANVAS' ? piece.width : (piece.naturalWidth || Math.round(pieceRect.width));
        const ph = piece.tagName === 'CANVAS' ? piece.height : (piece.naturalHeight || Math.round(pieceRect.height));
        const g2 = await grab(piece, pw, ph, 1);
        if (g2.b64.length > 100) slideImage = g2.b64;
      }

      return {
        x: hb.x + hb.width / 2,
        y: hb.y + hb.height / 2,
        handleWidth: hb.width,
        trackWidth: tb.width,
        bgWidth: bgb.width,
        bgNaturalWidth: g.w,
        bgOffsetX: bgb.x,
        bgImage: g.b64,
        bgVia: g.via,
        bgBlankSuspect: g.blank || undefined,
        bgAltImage: g.alt || undefined,
        bgAltVia: g.altVia || undefined,
        handleFound: how,
        slideImage: slideImage || undefined,
        pieceCenterX: pieceRect ? pieceRect.x + pieceRect.width / 2 : undefined,
        refreshX: refreshRect ? refreshRect.x + refreshRect.width / 2 : undefined,
        refreshY: refreshRect ? refreshRect.y + refreshRect.height / 2 : undefined,
        failed: failed || undefined,
      };
    })()
  `;
}
;module.exports=puzzleProbeScript;