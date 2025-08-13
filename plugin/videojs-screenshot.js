/* Video.js Screenshot Plugin - videojs-screenshot
 * Provides: capture frame, controls panel, gallery modal, settings, auto-capture, filters, crop, watermark, hotkeys, timelapse.
 */
(function(window, videojs){
  const Button = videojs.getComponent('Button');

  const DEFAULT_OPTIONS = {
    buttons: { capture: true, controls: true, gallery: true },
    storage: { type: 'browser', http: { endpoint: '', method: 'POST', headers: {}, fieldName: 'file' } },
    filters: { preset: 'none', custom: '' },
    watermark: { enabled: false, text: '', position: 'bottom-right', color: '#ffffff', opacity: 0.8, size: 16 },
    capture: { format: 'image/png', quality: 0.92, includeTimestamp: false },
    gallery: { layout: 'grid', thumbSize: 160 },
    hotkeys: { enabled: true, mapping: { capture: 'KeyC', toggleControlsPanel: 'KeyM', toggleGallery: 'KeyG', toggleAutoCapture: 'KeyI', exportTimelapse: 'KeyE' } },
    autocapture: { enabled: false, intervalMs: 5000 },
    ui: {
      gallery: { buttons: { download: true, edit: true, share: true, delete: true }, custom: [] },
      fullview: { buttons: { download: true, delete: true, copy: true, share: true, close: true, annotate: true }, custom: [] }
    },
    localization: {}
  };

  function mergeDeep(target, source){
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target)) Object.assign(output, {[key]: source[key]});
          else output[key] = mergeDeep(target[key], source[key]);
        } else {
          Object.assign(output, {[key]: source[key]});
        }
      });
    }
    return output;
  }
  function isObject(item){ return item && typeof item === 'object' && !Array.isArray(item); }

  function t(localization, key, fallback){
    return (localization && localization[key]) || fallback;
  }

  function uid(){ return 'ss_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  class BrowserStorage {
    constructor(namespace){ this.namespace = namespace || 'vjs_ss_'; }
    getAll(){
      const items = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.namespace)){
          try {
            const v = JSON.parse(localStorage.getItem(k));
            items.push(v);
          }catch(e){ /* noop */ }
        }
      }
      items.sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
      return items;
    }
    save(item){
      const id = item.id || uid();
      const toSave = { ...item, id, createdAt: item.createdAt || Date.now() };
      localStorage.setItem(this.namespace + id, JSON.stringify(toSave));
      return toSave;
    }
    remove(id){ localStorage.removeItem(this.namespace + id); }
    clear(){
      const keys = [];
      for (let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if (k && k.startsWith(this.namespace)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    }
  }

  function createEl(tag, className, attrs){
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (attrs){ Object.entries(attrs).forEach(([k,v])=> el.setAttribute(k, v)); }
    return el;
  }

  function applyCssFilter(ctx, width, height, preset, customCss){
    // canvas 2D context supports filter CSS-like syntax
    const filterMap = {
      none: 'none',
      grayscale: 'grayscale(100%)',
      sepia: 'sepia(100%)',
      invert: 'invert(100%)',
      contrast: 'contrast(130%)',
      saturate: 'saturate(140%)',
      blur: 'blur(1px)'
    };
    const finalFilter = customCss && customCss.trim() ? customCss : (filterMap[preset] || 'none');
    ctx.filter = finalFilter;
  }

  function drawWatermark(ctx, width, height, watermark){
    if (!watermark || !watermark.enabled || !watermark.text) return;
    const pad = 8;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, watermark.opacity || 0.8));
    ctx.fillStyle = watermark.color || '#ffffff';
    ctx.font = `${watermark.size || 16}px sans-serif`;
    const metrics = ctx.measureText(watermark.text);
    const textW = metrics.width;
    const textH = (watermark.size || 16);

    let x = pad, y = pad + textH;
    const pos = watermark.position || 'bottom-right';
    if (pos.includes('right')) x = width - textW - pad;
    if (pos.includes('bottom')) y = height - pad;
    if (pos.includes('top')) y = pad + textH;
    if (pos.includes('center')) { x = (width - textW) / 2; }

    ctx.fillText(watermark.text, x, y);
    ctx.restore();
  }

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'capture.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 5000);
  }

  function dataUrlToBlob(dataUrl){
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length; const u8arr = new Uint8Array(n);
    while(n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
  }

  function framesToZip(frames){
    // Lightweight zip via browser native compression isn't available; build simple tar-like data URL? Too heavy.
    // Instead, return an array; consumer can download individually, or we can generate a WebM from frames.
    return frames;
  }

  class ScreenshotPlugin {
    constructor(player, options){
      this.player = player;
      this.options = mergeDeep(DEFAULT_OPTIONS, options || {});
      this.state = {
        panelOpen: false,
        modalOpen: false,
        currentTab: 'gallery',
        items: [],
        cropping: false,
        cropRect: null,
        autoCaptureTimer: null,
        annotationMode: false,
        annotating: false,
        annotationCanvas: null,
        annotationCtx: null,
      };

      this.storage = new BrowserStorage('vjs_ss_');
      this._setup();
    }

    _setup(){
      this._injectUi();
      this._addControlBarButtons();
      this._bindHotkeys();
      this._loadFromStorage();
      this._maybeStartAutoCapture();
    }

    dispose(){
      this._stopAutoCapture();
      document.removeEventListener('keydown', this._hotkeyHandler, true);
    }

    _injectUi(){
      const playerEl = this.player.el();

      // Panel
      this.panel = createEl('div', 'vjs-ss-panel', { 'data-panel': 'capture-controls' });
      this.panel.innerHTML = `
        <div class="vjs-ss-panel-header">
          <h4>${t(this.options.localization, 'panel_title', 'Capture Controls')}</h4>
          <div>
            <button class="btn" data-action="toggle-autocap">${t(this.options.localization, 'auto_capture', 'Auto-capture')}</button>
            <button class="btn" data-action="close-panel">✕</button>
          </div>
        </div>
        <div class="vjs-ss-panel-body">
          <div class="row">
            <label>${t(this.options.localization, 'filters', 'Filters')}</label>
            <div class="vjs-ss-field-row">
              <select data-field="preset">
                <option value="none">None</option>
                <option value="grayscale">Grayscale</option>
                <option value="sepia">Sepia</option>
                <option value="invert">Invert</option>
                <option value="contrast">High Contrast</option>
                <option value="saturate">Saturate</option>
                <option value="blur">Slight Blur</option>
              </select>
            </div>
            <div class="vjs-ss-field-row">
              <input type="text" placeholder="custom CSS filter e.g. blur(2px) brightness(120%)" data-field="customFilter" />
            </div>
          </div>

          <div class="row">
            <label>${t(this.options.localization, 'crop_zoom', 'Crop / Zoom')}</label>
            <div class="btn-row">
              <button class="btn" data-action="start-crop">${t(this.options.localization, 'start_crop', 'Start Crop')}</button>
              <button class="btn" data-action="clear-crop">${t(this.options.localization, 'clear_crop', 'Clear')}</button>
            </div>
            <small class="muted">${t(this.options.localization, 'crop_hint', 'Drag to select a region over the video')}</small>
          </div>

          <div class="row">
            <label>${t(this.options.localization, 'storage', 'Storage')}</label>
            <div class="vjs-ss-field-row">
              <select data-field="storageType">
                <option value="browser">Browser</option>
              </select>
            </div>
          </div>

          <div class="row">
            <label>${t(this.options.localization, 'auto_interval', 'Auto-capture interval (ms)')}</label>
            <div class="vjs-ss-field-row"><input type="number" min="500" step="100" data-field="intervalMs" /></div>
          </div>

          <div class="row">
            <label>${t(this.options.localization, 'formatting', 'Formatting & Watermark')}</label>
            <div class="vjs-ss-field-row">
              <select data-field="format">
                <option value="image/png">PNG</option>
                <option value="image/jpeg">JPEG</option>
              </select>
              <input type="number" min="0" max="1" step="0.01" placeholder="quality (jpeg)" data-field="quality" />
            </div>
            <div class="vjs-ss-field-row">
              <label><input type="checkbox" data-field="wmEnabled" /> ${t(this.options.localization, 'watermark', 'Watermark')}</label>
              <input type="text" placeholder="watermark text" data-field="wmText" />
            </div>
          </div>

          <div class="btn-row">
            <button class="btn primary" data-action="capture">${t(this.options.localization, 'capture', 'Capture')}</button>
            <button class="btn" data-action="open-gallery">${t(this.options.localization, 'open_gallery', 'Open Gallery')}</button>
            <button class="btn" data-action="export-timelapse">${t(this.options.localization, 'export_timelapse', 'Export Timelapse')}</button>
          </div>
        </div>
      `;
      playerEl.appendChild(this.panel);

      // Crop overlay
      this.cropOverlay = createEl('div', 'vjs-ss-crop-overlay');
      this.cropOverlay.innerHTML = `
        <div class="vjs-ss-crop-handle tl"></div>
        <div class="vjs-ss-crop-handle tr"></div>
        <div class="vjs-ss-crop-handle bl"></div>
        <div class="vjs-ss-crop-handle br"></div>
      `;
      playerEl.appendChild(this.cropOverlay);

      // Modal
      this.modal = createEl('div', 'vjs-ss-modal');
      this.modal.innerHTML = `
        <div class="vjs-ss-modal-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <h3>${t(this.options.localization, 'gallery_title', 'Capture Gallery')}</h3>
            <span class="badge" data-badge="count">0</span>
          </div>
          <div class="vjs-ss-tabs">
            <button class="vjs-ss-tab active" data-tab="gallery">${t(this.options.localization, 'tab_gallery', 'Gallery')}</button>
            <button class="vjs-ss-tab" data-tab="settings">${t(this.options.localization, 'tab_settings', 'Settings')}</button>
            <button class="btn" data-action="close-modal">${t(this.options.localization, 'close', 'Close')}</button>
          </div>
        </div>
        <div class="vjs-ss-modal-body">
          <div class="vjs-ss-gallery" data-view="gallery"></div>
          <div class="vjs-ss-settings vjs-ss-hidden" data-view="settings"></div>
        </div>
        <div class="vjs-ss-fullview" data-view="fullview">
          <div class="canvas-wrap">
            <div class="toolbar" data-fv="toolbar"></div>
            <img data-fv="image" alt="full view" />
          </div>
        </div>
      `;
      playerEl.appendChild(this.modal);

      // Connect panel controls
      this._wirePanel();
      this._renderSettings();
    }

    _addControlBarButtons(){
      const player = this.player;
      const self = this;

      function makeButton(name, iconText, tooltip, action){
        const cls = videojs.dom.createEl('button', { className: 'vjs-screenshot-btn vjs-control', innerHTML: `<span class="vjs-icon-placeholder">${iconText}</span>` });
        cls.setAttribute('aria-label', tooltip);
        cls.setAttribute('title', tooltip);
        cls.onclick = (e)=>{ e.preventDefault(); action(); };
        return cls;
      }

      if (this.options.buttons.capture){
        const btn = makeButton('capture', '📷', t(this.options.localization, 'capture', 'Capture'), ()=> this.capture());
        player.controlBar.el().insertBefore(btn, player.controlBar.fullscreenToggle.el());
      }

      if (this.options.buttons.controls){
        const btn = makeButton('controls', '🎛️', t(this.options.localization, 'toggle_controls_panel', 'Toggle Controls Panel'), ()=> this.togglePanel());
        player.controlBar.el().insertBefore(btn, player.controlBar.fullscreenToggle.el());
      }

      if (this.options.buttons.gallery){
        const btn = makeButton('gallery', '🖼️', t(this.options.localization, 'toggle_gallery', 'Toggle Gallery'), ()=> this.toggleModal());
        player.controlBar.el().insertBefore(btn, player.controlBar.fullscreenToggle.el());
      }
    }

    _wirePanel(){
      const p = this.panel;
      const q = (sel) => p.querySelector(sel);

      q('button[data-action="close-panel"]').addEventListener('click', ()=> this.togglePanel(false));
      q('button[data-action="capture"]').addEventListener('click', ()=> this.capture());
      q('button[data-action="open-gallery"]').addEventListener('click', ()=> this.toggleModal(true));
      q('button[data-action="export-timelapse"]').addEventListener('click', ()=> this.exportTimelapse());
      q('button[data-action="start-crop"]').addEventListener('click', ()=> this._startCrop());
      q('button[data-action="clear-crop"]').addEventListener('click', ()=> this._clearCrop());
      q('button[data-action="toggle-autocap"]').addEventListener('click', ()=> this.toggleAutoCapture());

      q('select[data-field="preset"]').value = this.options.filters.preset || 'none';
      q('input[data-field="customFilter"]').value = this.options.filters.custom || '';
      this._applyLiveFilter();
      q('select[data-field="storageType"]').value = this.options.storage.type || 'browser';
      q('input[data-field="intervalMs"]').value = this.options.autocapture.intervalMs || 5000;
      q('select[data-field="format"]').value = this.options.capture.format || 'image/png';
      q('input[data-field="quality"]').value = this.options.capture.quality || 0.92;
      q('input[data-field="wmEnabled"]').checked = !!this.options.watermark.enabled;
      q('input[data-field="wmText"]').value = this.options.watermark.text || '';

      p.addEventListener('change', (e)=>{
        const t = e.target;
        if (t.matches('select[data-field="preset"]')) { this.options.filters.preset = t.value; this._applyLiveFilter(); }
        if (t.matches('input[data-field="customFilter"]')) { this.options.filters.custom = t.value; this._applyLiveFilter(); }
        if (t.matches('select[data-field="storageType"]')) this.options.storage.type = t.value;
        if (t.matches('input[data-field="intervalMs"]')) this.options.autocapture.intervalMs = Math.max(200, Number(t.value) || 5000);
        if (t.matches('select[data-field="format"]')) this.options.capture.format = t.value;
        if (t.matches('input[data-field="quality"]')) this.options.capture.quality = Number(t.value) || 0.92;
        if (t.matches('input[data-field="wmEnabled"]')) this.options.watermark.enabled = t.checked;
        if (t.matches('input[data-field="wmText"]')) this.options.watermark.text = t.value;
      });

      this._wireCropInteractions();
      this._wireModal();
    }

    _wireModal(){
      const m = this.modal;
      const q = (sel)=> m.querySelector(sel);
      q('button[data-action="close-modal"]').addEventListener('click', ()=> this.toggleModal(false));
      const tabs = m.querySelectorAll('.vjs-ss-tab');
      tabs.forEach(tab => tab.addEventListener('click', ()=>{
        tabs.forEach(t=> t.classList.remove('active'));
        tab.classList.add('active');
        this.state.currentTab = tab.getAttribute('data-tab');
        this._renderModalViews();
      }));

      // Fullview toolbar
      this._renderFullviewToolbar();
      q('img[data-fv="image"]').addEventListener('load', ()=> this._ensureAnnotationOverlay());
    }

    _renderModalViews(){
      const m = this.modal;
      const isSettings = this.state.currentTab === 'settings';
      m.querySelector('[data-view="gallery"]').classList.toggle('vjs-ss-hidden', isSettings);
      m.querySelector('[data-view="settings"]').classList.toggle('vjs-ss-hidden', !isSettings);

      if (isSettings) this._renderSettings();
      else this._renderGallery();
    }

    _renderSettings(){
      const s = this.modal.querySelector('[data-view="settings"]');
      s.innerHTML = '';

      // Hotkeys
      const hotkeys = createEl('div', 'vjs-ss-card');
      hotkeys.innerHTML = `
        <h4>${t(this.options.localization, 'hotkeys', 'Hotkeys')}</h4>
        <div class="vjs-ss-field">
          <label><input type="checkbox" data-setting="hkEnabled" ${this.options.hotkeys.enabled ? 'checked' : ''}/> ${t(this.options.localization, 'enable_hotkeys', 'Enable hotkeys')}</label>
          <div class="vjs-ss-field-row">
            <label>Capture</label>
            <input type="text" data-setting="hkCapture" value="${this.options.hotkeys.mapping.capture}" />
          </div>
          <div class="vjs-ss-field-row">
            <label>Toggle Controls</label>
            <input type="text" data-setting="hkControls" value="${this.options.hotkeys.mapping.toggleControlsPanel}" />
          </div>
          <div class="vjs-ss-field-row">
            <label>Toggle Gallery</label>
            <input type="text" data-setting="hkGallery" value="${this.options.hotkeys.mapping.toggleGallery}" />
          </div>
          <div class="vjs-ss-field-row">
            <label>Toggle Auto-capture</label>
            <input type="text" data-setting="hkAuto" value="${this.options.hotkeys.mapping.toggleAutoCapture}" />
          </div>
          <div class="vjs-ss-field-row">
            <label>Export Timelapse</label>
            <input type="text" data-setting="hkExport" value="${this.options.hotkeys.mapping.exportTimelapse}" />
          </div>
        </div>
      `;

      // Filters
      const filters = createEl('div', 'vjs-ss-card');
      filters.innerHTML = `
        <h4>${t(this.options.localization, 'filters', 'Filters')}</h4>
        <div class="vjs-ss-field-row">
          <select data-setting="preset">
            <option value="none" ${this.options.filters.preset==='none'?'selected':''}>None</option>
            <option value="grayscale" ${this.options.filters.preset==='grayscale'?'selected':''}>Grayscale</option>
            <option value="sepia" ${this.options.filters.preset==='sepia'?'selected':''}>Sepia</option>
            <option value="invert" ${this.options.filters.preset==='invert'?'selected':''}>Invert</option>
            <option value="contrast" ${this.options.filters.preset==='contrast'?'selected':''}>High Contrast</option>
            <option value="saturate" ${this.options.filters.preset==='saturate'?'selected':''}>Saturate</option>
            <option value="blur" ${this.options.filters.preset==='blur'?'selected':''}>Slight Blur</option>
          </select>
          <input type="text" placeholder="custom CSS filter" data-setting="custom" value="${this.options.filters.custom || ''}" />
        </div>
      `;

      // Storage
      const storage = createEl('div', 'vjs-ss-card');
      storage.innerHTML = `
        <h4>${t(this.options.localization, 'storage', 'Storage')}</h4>
        <div class="vjs-ss-field-row">
          <select data-setting="storageType">
            <option value="browser" ${this.options.storage.type==='browser'?'selected':''}>Browser</option>
            <option value="http" ${this.options.storage.type==='http'?'selected':''}>HTTP Upload</option>
          </select>
          <button class="btn" data-action="clear-storage">${t(this.options.localization, 'clear', 'Clear')}</button>
        </div>
        <div class="vjs-ss-field">
          <div class="vjs-ss-field-row">
            <input type="text" data-setting="httpEndpoint" placeholder="HTTP endpoint" value="${this.options.storage.http.endpoint || ''}" />
            <select data-setting="httpMethod">
              <option value="POST" ${this.options.storage.http.method==='POST'?'selected':''}>POST</option>
              <option value="PUT" ${this.options.storage.http.method==='PUT'?'selected':''}>PUT</option>
            </select>
          </div>
          <div class="vjs-ss-field-row">
            <input type="text" data-setting="httpFieldName" placeholder="file field name" value="${this.options.storage.http.fieldName || 'file'}" />
          </div>
        </div>
      `;

      // Buttons visibility
      const buttons = createEl('div', 'vjs-ss-card');
      buttons.innerHTML = `
        <h4>${t(this.options.localization, 'buttons', 'Buttons')}</h4>
        <label><input type="checkbox" data-setting="btnCapture" ${this.options.buttons.capture?'checked':''}/> ${t(this.options.localization, 'capture_button', 'Capture Button')}</label>
        <label><input type="checkbox" data-setting="btnControls" ${this.options.buttons.controls?'checked':''}/> ${t(this.options.localization, 'controls_button', 'Controls Panel Button')}</label>
        <label><input type="checkbox" data-setting="btnGallery" ${this.options.buttons.gallery?'checked':''}/> ${t(this.options.localization, 'gallery_button', 'Gallery Button')}</label>
      `;

      // Gallery view
      const gallery = createEl('div', 'vjs-ss-card');
      gallery.innerHTML = `
        <h4>${t(this.options.localization, 'gallery_view', 'Gallery View')}</h4>
        <div class="vjs-ss-field-row">
          <select data-setting="layout">
            <option value="grid" ${this.options.gallery.layout==='grid'?'selected':''}>Grid</option>
            <option value="list" ${this.options.gallery.layout==='list'?'selected':''}>List</option>
          </select>
          <input type="number" min="80" max="320" step="10" data-setting="thumbSize" value="${this.options.gallery.thumbSize || 160}" />
        </div>
      `;

      // Capture / watermark
      const formatting = createEl('div', 'vjs-ss-card');
      formatting.innerHTML = `
        <h4>${t(this.options.localization, 'formatting', 'Formatting & Watermark')}</h4>
        <div class="vjs-ss-field-row">
          <select data-setting="format">
            <option value="image/png" ${this.options.capture.format==='image/png'?'selected':''}>PNG</option>
            <option value="image/jpeg" ${this.options.capture.format==='image/jpeg'?'selected':''}>JPEG</option>
          </select>
          <input type="number" min="0" max="1" step="0.01" data-setting="quality" value="${this.options.capture.quality}" />
        </div>
        <div class="vjs-ss-field-row">
          <label><input type="checkbox" data-setting="wmEnabled" ${this.options.watermark.enabled?'checked':''}/> ${t(this.options.localization, 'watermark', 'Watermark')}</label>
          <input type="text" data-setting="wmText" value="${this.options.watermark.text || ''}" placeholder="watermark text" />
        </div>
      `;

      // Auto capture
      const autocap = createEl('div', 'vjs-ss-card');
      autocap.innerHTML = `
        <h4>${t(this.options.localization, 'auto_capture', 'Auto-capture')}</h4>
        <div class="vjs-ss-field-row">
          <label><input type="checkbox" data-setting="acEnabled" ${this.options.autocapture.enabled?'checked':''}/> ${t(this.options.localization, 'enabled', 'Enabled')}</label>
          <input type="number" min="200" step="100" data-setting="intervalMs" value="${this.options.autocapture.intervalMs}" />
          <button class="btn" data-action="toggle-autocap">${t(this.options.localization, 'toggle', 'Toggle')}</button>
        </div>
      `;

      // Advanced
      const advanced = createEl('div', 'vjs-ss-card');
      advanced.innerHTML = `
        <h4>${t(this.options.localization, 'advanced', 'Advanced')}</h4>
        <div class="vjs-ss-field-row">
          <label><input type="checkbox" data-setting="annotation" ${this.state.annotationMode?'checked':''}/> ${t(this.options.localization, 'annotation_mode', 'Annotation mode')}</label>
          <button class="btn" data-action="export-timelapse">${t(this.options.localization, 'export_timelapse', 'Export Timelapse')}</button>
        </div>
      `;

      // Gallery buttons toggle
      const galleryButtons = createEl('div', 'vjs-ss-card');
      galleryButtons.innerHTML = `
        <h4>${t(this.options.localization, 'gallery_item_buttons', 'Gallery Item Buttons')}</h4>
        <label><input type="checkbox" data-setting="gbtnDownload" ${this.options.ui.gallery.buttons.download?'checked':''}/> ${t(this.options.localization, 'download', 'Download')}</label>
        <label><input type="checkbox" data-setting="gbtnEdit" ${this.options.ui.gallery.buttons.edit?'checked':''}/> ${t(this.options.localization, 'edit', 'Edit')}</label>
        <label><input type="checkbox" data-setting="gbtnShare" ${this.options.ui.gallery.buttons.share?'checked':''}/> ${t(this.options.localization, 'share', 'Share')}</label>
        <label><input type="checkbox" data-setting="gbtnDelete" ${this.options.ui.gallery.buttons.delete?'checked':''}/> ${t(this.options.localization, 'delete', 'Delete')}</label>
      `;

      // Fullview buttons toggle
      const fullButtons = createEl('div', 'vjs-ss-card');
      fullButtons.innerHTML = `
        <h4>${t(this.options.localization, 'fullview_buttons', 'Full View Buttons')}</h4>
        <label><input type="checkbox" data-setting="fvDownload" ${this.options.ui.fullview.buttons.download?'checked':''}/> ${t(this.options.localization, 'download', 'Download')}</label>
        <label><input type="checkbox" data-setting="fvDelete" ${this.options.ui.fullview.buttons.delete?'checked':''}/> ${t(this.options.localization, 'delete', 'Delete')}</label>
        <label><input type="checkbox" data-setting="fvCopy" ${this.options.ui.fullview.buttons.copy?'checked':''}/> ${t(this.options.localization, 'copy', 'Copy')}</label>
        <label><input type="checkbox" data-setting="fvShare" ${this.options.ui.fullview.buttons.share?'checked':''}/> ${t(this.options.localization, 'share', 'Share')}</label>
        <label><input type="checkbox" data-setting="fvAnnotate" ${this.options.ui.fullview.buttons.annotate?'checked':''}/> ${t(this.options.localization, 'annotate', 'Annotate')}</label>
        <label><input type="checkbox" data-setting="fvClose" ${this.options.ui.fullview.buttons.close?'checked':''}/> ${t(this.options.localization, 'close', 'Close')}</label>
      `;

      [hotkeys, filters, storage, buttons, gallery, formatting, autocap, advanced, galleryButtons, fullButtons].forEach(el => s.appendChild(el));

      s.addEventListener('change', (e)=>{
        const tEl = e.target;
        const ds = tEl.getAttribute('data-setting');
        if (!ds) return;
        switch(ds){
          case 'hkEnabled': this.options.hotkeys.enabled = tEl.checked; break;
          case 'hkCapture': this.options.hotkeys.mapping.capture = tEl.value || 'KeyC'; break;
          case 'hkControls': this.options.hotkeys.mapping.toggleControlsPanel = tEl.value || 'KeyM'; break;
          case 'hkGallery': this.options.hotkeys.mapping.toggleGallery = tEl.value || 'KeyG'; break;
          case 'hkAuto': this.options.hotkeys.mapping.toggleAutoCapture = tEl.value || 'KeyI'; break;
          case 'hkExport': this.options.hotkeys.mapping.exportTimelapse = tEl.value || 'KeyE'; break;
          case 'preset': this.options.filters.preset = tEl.value; this._applyLiveFilter(); break;
          case 'custom': this.options.filters.custom = tEl.value; this._applyLiveFilter(); break;
          case 'storageType': this.options.storage.type = tEl.value; break;
          case 'httpEndpoint': this.options.storage.http.endpoint = tEl.value; break;
          case 'httpMethod': this.options.storage.http.method = tEl.value; break;
          case 'httpFieldName': this.options.storage.http.fieldName = tEl.value || 'file'; break;
          case 'btnCapture': this.options.buttons.capture = tEl.checked; this._refreshButtons(); break;
          case 'btnControls': this.options.buttons.controls = tEl.checked; this._refreshButtons(); break;
          case 'btnGallery': this.options.buttons.gallery = tEl.checked; this._refreshButtons(); break;
          case 'layout': this.options.gallery.layout = tEl.value; this._renderGallery(); break;
          case 'thumbSize': this.options.gallery.thumbSize = Number(tEl.value)||160; this._renderGallery(); break;
          case 'format': this.options.capture.format = tEl.value; break;
          case 'quality': this.options.capture.quality = Number(tEl.value)||0.92; break;
          case 'wmEnabled': this.options.watermark.enabled = tEl.checked; break;
          case 'wmText': this.options.watermark.text = tEl.value; break;
          case 'acEnabled': this.options.autocapture.enabled = tEl.checked; this._maybeStartAutoCapture(); break;
          case 'intervalMs': this.options.autocapture.intervalMs = Math.max(200, Number(tEl.value)||5000); this._maybeStartAutoCapture(); break;
          case 'annotation': this.state.annotationMode = tEl.checked; break;
          case 'gbtnDownload': this.options.ui.gallery.buttons.download = tEl.checked; this._renderGallery(); break;
          case 'gbtnEdit': this.options.ui.gallery.buttons.edit = tEl.checked; this._renderGallery(); break;
          case 'gbtnShare': this.options.ui.gallery.buttons.share = tEl.checked; this._renderGallery(); break;
          case 'gbtnDelete': this.options.ui.gallery.buttons.delete = tEl.checked; this._renderGallery(); break;
          case 'fvDownload': this.options.ui.fullview.buttons.download = tEl.checked; this._renderFullviewToolbar(); break;
          case 'fvDelete': this.options.ui.fullview.buttons.delete = tEl.checked; this._renderFullviewToolbar(); break;
          case 'fvCopy': this.options.ui.fullview.buttons.copy = tEl.checked; this._renderFullviewToolbar(); break;
          case 'fvShare': this.options.ui.fullview.buttons.share = tEl.checked; this._renderFullviewToolbar(); break;
          case 'fvAnnotate': this.options.ui.fullview.buttons.annotate = tEl.checked; this._renderFullviewToolbar(); break;
          case 'fvClose': this.options.ui.fullview.buttons.close = tEl.checked; this._renderFullviewToolbar(); break;
        }
      });

      s.querySelector('button[data-action="clear-storage"]').addEventListener('click', ()=>{
        this.storage.clear();
        this.state.items = [];
        this._renderGallery();
        this._updateModalCount();
      });

      s.querySelector('button[data-action="export-timelapse"]').addEventListener('click', ()=> this.exportTimelapse());
      s.querySelector('button[data-action="toggle-autocap"]').addEventListener('click', ()=> this.toggleAutoCapture());
    }

    _refreshButtons(){
      // Remove and re-add to reflect visibility
      const bar = this.player.controlBar.el();
      const existing = bar.querySelectorAll('.vjs-screenshot-btn');
      existing.forEach(el => el.remove());
      this._addControlBarButtons();
    }

    togglePanel(force){
      if (typeof force === 'boolean') this.state.panelOpen = force; else this.state.panelOpen = !this.state.panelOpen;
      this.panel.classList.toggle('show', this.state.panelOpen);
    }

    toggleModal(force){
      if (typeof force === 'boolean') this.state.modalOpen = force; else this.state.modalOpen = !this.state.modalOpen;
      this.modal.classList.toggle('show', this.state.modalOpen);
      if (this.state.modalOpen) {
        this._renderModalViews();
        this._updateModalCount();
      }
    }

    _updateModalCount(){
      const b = this.modal.querySelector('[data-badge="count"]');
      if (b) b.textContent = String(this.state.items.length);
    }

    _bindHotkeys(){
      this._hotkeyHandler = (e)=>{
        if (!this.options.hotkeys.enabled) return;
        // Avoid when focused in inputs
        if (/INPUT|TEXTAREA|SELECT/.test((e.target||{}).tagName)) return;
        const code = e.code;
        const map = this.options.hotkeys.mapping || {};
        if (code === map.capture) { e.preventDefault(); this.capture(); }
        else if (code === map.toggleControlsPanel) { e.preventDefault(); this.togglePanel(); }
        else if (code === map.toggleGallery) { e.preventDefault(); this.toggleModal(); }
        else if (code === map.toggleAutoCapture) { e.preventDefault(); this.toggleAutoCapture(); }
        else if (code === map.exportTimelapse) { e.preventDefault(); this.exportTimelapse(); }
      };
      document.addEventListener('keydown', this._hotkeyHandler, true);
    }

    _wireCropInteractions(){
      const playerEl = this.player.el();
      const videoEl = this.player.el().querySelector('video');
      const overlay = this.cropOverlay;
      let startX = 0, startY = 0, dragging = false;

      const onDown = (e)=>{
        if (!this.state.cropping) return;
        dragging = true;
        const rect = playerEl.getBoundingClientRect();
        const clientX = e.touches? e.touches[0].clientX : e.clientX;
        const clientY = e.touches? e.touches[0].clientY : e.clientY;
        startX = clientX - rect.left; startY = clientY - rect.top;
        this.state.cropRect = { x: startX, y: startY, w: 0, h: 0 };
        this._updateCropOverlay();
      };
      const onMove = (e)=>{
        if (!dragging) return;
        const rect = playerEl.getBoundingClientRect();
        const clientX = e.touches? e.touches[0].clientX : e.clientX;
        const clientY = e.touches? e.touches[0].clientY : e.clientY;
        const x = clientX - rect.left; const y = clientY - rect.top;
        this.state.cropRect.w = Math.max(0, x - startX);
        this.state.cropRect.h = Math.max(0, y - startY);
        this._updateCropOverlay();
      };
      const onUp = ()=>{ dragging = false; };

      playerEl.addEventListener('mousedown', onDown);
      playerEl.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      playerEl.addEventListener('touchstart', onDown, { passive: true });
      playerEl.addEventListener('touchmove', onMove, { passive: true });
      window.addEventListener('touchend', onUp);
    }

    _startCrop(){
      this.state.cropping = true;
      this.cropOverlay.classList.add('show');
    }

    _clearCrop(){
      this.state.cropping = false;
      this.state.cropRect = null;
      this._updateCropOverlay();
      this.cropOverlay.classList.remove('show');
    }

    _updateCropOverlay(){
      const r = this.state.cropRect;
      if (!r) { this.cropOverlay.style.display='none'; return; }
      this.cropOverlay.style.display = 'block';
      this.cropOverlay.style.left = r.x + 'px';
      this.cropOverlay.style.top = r.y + 'px';
      this.cropOverlay.style.width = Math.max(0, r.w) + 'px';
      this.cropOverlay.style.height = Math.max(0, r.h) + 'px';
    }

    _loadFromStorage(){
      this.state.items = this.storage.getAll();
    }

    toggleAutoCapture(){
      this.options.autocapture.enabled = !this.options.autocapture.enabled;
      this._maybeStartAutoCapture();
    }

    _maybeStartAutoCapture(){
      this._stopAutoCapture();
      if (this.options.autocapture.enabled){
        this.state.autoCaptureTimer = setInterval(()=>{
          this.capture({ silent: true });
        }, this.options.autocapture.intervalMs || 5000);
      }
    }

    _stopAutoCapture(){ if (this.state.autoCaptureTimer){ clearInterval(this.state.autoCaptureTimer); this.state.autoCaptureTimer = null; } }

    capture({ silent } = {}){
      const video = this.player.el().querySelector('video');
      if (!video || video.readyState < 2) return;

      const hasCrop = !!(this.state.cropRect && (this.state.cropRect.w > 2) && (this.state.cropRect.h > 2));
      let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
      if (hasCrop){
        // Map crop overlay rect (player CSS pixels) to video pixels
        const playerRect = this.player.el().getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        const scaleX = video.videoWidth / videoRect.width;
        const scaleY = video.videoHeight / videoRect.height;
        const rx = this.state.cropRect.x - (videoRect.left - playerRect.left);
        const ry = this.state.cropRect.y - (videoRect.top - playerRect.top);
        sx = Math.max(0, Math.floor(rx * scaleX));
        sy = Math.max(0, Math.floor(ry * scaleY));
        sw = Math.max(1, Math.floor(this.state.cropRect.w * scaleX));
        sh = Math.max(1, Math.floor(this.state.cropRect.h * scaleY));
      }

      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d');
      applyCssFilter(ctx, sw, sh, this.options.filters.preset, this.options.filters.custom);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

      drawWatermark(ctx, sw, sh, this.options.watermark);
      if (this.options.capture.includeTimestamp){
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(8, sh - 26, 120, 18);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        const ts = `t=${this.player.currentTime().toFixed(2)}s`;
        ctx.fillText(ts, 12, sh - 12);
        ctx.restore();
      }

      const mime = this.options.capture.format || 'image/png';
      const quality = this.options.capture.quality || 0.92;
      const dataUrl = canvas.toDataURL(mime, quality);

      const item = this.storage.save({
        id: uid(),
        dataUrl,
        mime,
        createdAt: Date.now(),
        meta: {
          currentTime: this.player.currentTime(),
          filter: { ...this.options.filters },
          crop: hasCrop ? { sx, sy, sw, sh } : null,
          watermark: { ...this.options.watermark },
          size: { width: sw, height: sh }
        }
      });
      this.state.items.push(item);
      // Optional HTTP upload
      if (this.options.storage.type === 'http' && this.options.storage.http && this.options.storage.http.endpoint){
        try {
          const blob = dataUrlToBlob(dataUrl);
          const form = new FormData();
          form.append(this.options.storage.http.fieldName || 'file', blob, `capture_${item.id}.png`);
          const resp = fetch(this.options.storage.http.endpoint, { method: this.options.storage.http.method || 'POST', headers: this.options.storage.http.headers || {}, body: form });
          Promise.resolve(resp).then(r => r.json()).then(json => {
            if (json && (json.url || json.location)){
              item.meta = item.meta || {}; item.meta.uploadedUrl = json.url || json.location;
              this.storage.save(item);
              this._renderGallery();
            }
          }).catch(()=>{});
        } catch(e){}
      }
      if (!silent) this._toast(t(this.options.localization, 'captured', 'Captured'));
      this._updateModalCount();
      this._renderGallery();
    }

    _toast(msg){
      const el = createEl('div', '', { style: 'position:absolute;left:50%;bottom:90px;transform:translateX(-50%);background:#141723;color:#e8e8ea;border:1px solid #2a2d36;border-radius:8px;padding:6px 10px;z-index:60;' });
      el.textContent = msg;
      this.player.el().appendChild(el);
      setTimeout(()=> el.remove(), 1200);
    }

    _renderGallery(){
      const g = this.modal.querySelector('[data-view="gallery"]');
      if (!g) return;
      g.classList.toggle('list', this.options.gallery.layout === 'list');
      g.style.setProperty('--thumbSize', (this.options.gallery.thumbSize||160)+'px');
      g.innerHTML = '';

      const items = this.state.items.slice().sort((a,b)=> b.createdAt - a.createdAt);
      items.forEach(item => {
        const card = createEl('div', 'vjs-ss-item');
        const imgWrap = createEl('div', 'vjs-ss-thumb');
        const img = createEl('img'); img.src = item.dataUrl; img.alt = 'capture';
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);

        const actions = createEl('div', 'vjs-ss-actions');
        const left = createEl('div'); left.style.display = 'flex'; left.style.gap = '6px';
        const right = createEl('div'); right.style.display = 'flex'; right.style.gap = '6px';
        if (this.options.ui.gallery.buttons.download){ const b = createEl('button', 'btn success'); b.textContent = t(this.options.localization, 'download', 'Download'); b.addEventListener('click', ()=> this._downloadItem(item)); left.appendChild(b); }
        if (this.options.ui.gallery.buttons.edit){ const b = createEl('button', 'btn'); b.textContent = t(this.options.localization, 'edit', 'Edit'); b.addEventListener('click', ()=> this._showFullView(item)); left.appendChild(b); }
        if (this.options.ui.gallery.buttons.share){ const b = createEl('button', 'btn info'); b.textContent = t(this.options.localization, 'share', 'Share'); b.addEventListener('click', ()=> this._shareItem(item)); left.appendChild(b); }
        if (this.options.ui.gallery.buttons.delete){ const b = createEl('button', 'btn danger'); b.textContent = t(this.options.localization, 'delete', 'Delete'); b.addEventListener('click', ()=> this._deleteItem(item)); right.appendChild(b); }
        actions.appendChild(left); actions.appendChild(right);
        card.appendChild(actions);

        img.addEventListener('click', ()=> this._showFullView(item));
        g.appendChild(card);
      });
    }

    _showFullView(item){
      const fv = this.modal.querySelector('[data-view="fullview"]');
      fv.classList.add('show');
      const img = fv.querySelector('[data-fv="image"]');
      img.src = item.dataUrl; img.setAttribute('data-id', item.id);
      // click outside to close
      const handler = (e)=>{
        const wrap = fv.querySelector('.canvas-wrap');
        if (!wrap.contains(e.target)){
          this._hideFullView();
          fv.removeEventListener('click', handler);
        }
      };
      setTimeout(()=> fv.addEventListener('click', handler));
    }

    _hideFullView(){ this.modal.querySelector('[data-view="fullview"]').classList.remove('show'); }

    _downloadItem(item){ downloadBlob(dataUrlToBlob(item.dataUrl), `capture_${item.id}.png`); }
    _shareItem(item){
      if (navigator.share){ navigator.share({ title: 'Capture', text: 'Video capture', url: item.dataUrl }).catch(()=>{}); }
      else if (navigator.clipboard){ navigator.clipboard.writeText(item.dataUrl).then(()=> this._toast('Copied link')).catch(()=>{}); }
    }
    _deleteItem(item){
      this.storage.remove(item.id);
      this.state.items = this.state.items.filter(x => x.id !== item.id);
      this._renderGallery();
      this._updateModalCount();
    }

    _fullviewFind(){
      const id = this.modal.querySelector('[data-fv="image"]').getAttribute('data-id');
      return this.state.items.find(x => x.id === id);
    }
    _fullviewDownload(){ const it = this._fullviewFind(); if (it) this._downloadItem(it); }
    _fullviewDelete(){ const it = this._fullviewFind(); if (it){ this._deleteItem(it); this._hideFullView(); } }
    _fullviewCopy(){ const it = this._fullviewFind(); if (it && navigator.clipboard){ navigator.clipboard.writeText(it.dataUrl).then(()=> this._toast('Copied')).catch(()=>{}); } }
    _fullviewShare(){ const it = this._fullviewFind(); if (it) this._shareItem(it); }

    exportTimelapse(){
      // Create a simple WebM from frames via Canvas CaptureStream with fixed frame rate
      const frames = this.state.items.slice().sort((a,b)=> a.createdAt - b.createdAt);
      if (frames.length === 0){ this._toast('No frames'); return; }

      const fps = 6; // configurable in future
      const first = frames[0];
      const img = new Image();
      img.onload = ()=>{
        const w = img.width, h = img.height;
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(fps);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = ()=>{
          const blob = new Blob(chunks, { type: 'video/webm' });
          downloadBlob(blob, 'timelapse.webm');
        };
        recorder.start();

        let idx = 0;
        const drawNext = ()=>{
          if (idx >= frames.length){ recorder.stop(); return; }
          const fr = new Image();
          fr.onload = ()=>{
            ctx.clearRect(0,0,w,h);
            ctx.drawImage(fr, 0, 0, w, h);
            setTimeout(()=>{ idx++; drawNext(); }, 1000 / fps);
          };
          fr.src = frames[idx].dataUrl;
        };
        drawNext();
      };
      img.src = first.dataUrl;
    }

    _renderFullviewToolbar(){
      const tb = this.modal.querySelector('[data-fv="toolbar"]');
      if (!tb) return;
      tb.innerHTML = '';
      const add = (key, labelKey, handler, cls='btn')=>{
        const b = createEl('button', cls); b.textContent = t(this.options.localization, labelKey, labelKey.replace('_',' ')); b.addEventListener('click', handler); tb.appendChild(b);
      };
      const cfg = this.options.ui.fullview.buttons;
      if (cfg.download) add('download', 'download', ()=> this._fullviewDownload(), 'btn success');
      if (cfg.delete) add('delete', 'delete', ()=> this._fullviewDelete(), 'btn danger');
      if (cfg.copy) add('copy', 'copy', ()=> this._fullviewCopy(), 'btn');
      if (cfg.share) add('share', 'share', ()=> this._fullviewShare(), 'btn info');
      if (cfg.annotate) add('annotate', 'annotate', ()=> this._toggleAnnotate(), 'btn warning');
      if (cfg.close) add('close', 'close', ()=> this._hideFullView(), 'btn');
    }

    _ensureAnnotationOverlay(){
      const wrap = this.modal.querySelector('.canvas-wrap');
      let cnv = wrap.querySelector('canvas[data-fv="annot"]');
      if (!cnv){
        cnv = createEl('canvas');
        cnv.setAttribute('data-fv', 'annot');
        cnv.style.position = 'absolute';
        cnv.style.left = '0'; cnv.style.top = '0';
        cnv.style.display = 'none';
        wrap.appendChild(cnv);
      }
      const img = this.modal.querySelector('img[data-fv="image"]');
      cnv.width = img.naturalWidth; cnv.height = img.naturalHeight;
      cnv.style.width = img.clientWidth + 'px';
      cnv.style.height = img.clientHeight + 'px';
      this.state.annotationCanvas = cnv;
      this.state.annotationCtx = cnv.getContext('2d');
      this._bindAnnotateInteractions();
    }

    _bindAnnotateInteractions(){
      const cnv = this.state.annotationCanvas;
      if (!cnv) return;
      let drawing = false, lastX = 0, lastY = 0;
      const getXY = (e)=>{
        const rect = cnv.getBoundingClientRect();
        const clientX = e.touches? e.touches[0].clientX : e.clientX;
        const clientY = e.touches? e.touches[0].clientY : e.clientY;
        const x = clientX - rect.left; const y = clientY - rect.top;
        // map to canvas coords
        const scaleX = cnv.width / rect.width; const scaleY = cnv.height / rect.height;
        return { x: x * scaleX, y: y * scaleY };
      };
      const down = (e)=>{ if (!this.state.annotating) return; drawing = true; const p = getXY(e); lastX = p.x; lastY = p.y; e.preventDefault(); };
      const move = (e)=>{ if (!drawing || !this.state.annotating) return; const p = getXY(e); const ctx = this.state.annotationCtx; ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke(); lastX = p.x; lastY = p.y; e.preventDefault(); };
      const up = ()=>{ drawing = false; };
      cnv.onmousedown = down; cnv.onmousemove = move; window.onmouseup = up;
      cnv.ontouchstart = down; cnv.ontouchmove = move; window.ontouchend = up;
    }

    _toggleAnnotate(){
      this.state.annotating = !this.state.annotating;
      if (this.state.annotationCanvas){ this.state.annotationCanvas.style.display = this.state.annotating ? 'block' : 'none'; }
      // When turning off, prompt to apply
      if (!this.state.annotating){ this._applyAnnotation(); }
    }

    _applyAnnotation(){
      const cnv = this.state.annotationCanvas; if (!cnv) return;
      const imgEl = this.modal.querySelector('img[data-fv="image"]');
      const tmp = document.createElement('canvas'); tmp.width = cnv.width; tmp.height = cnv.height; const tctx = tmp.getContext('2d');
      const base = new Image();
      base.onload = ()=>{
        tctx.drawImage(base, 0, 0);
        tctx.drawImage(cnv, 0, 0);
        const dataUrl = tmp.toDataURL(this.options.capture.format || 'image/png', this.options.capture.quality || 0.92);
        // update current item
        const it = this._fullviewFind(); if (!it) return;
        it.dataUrl = dataUrl; this.storage.save(it); // overwrite
        imgEl.src = dataUrl;
        this._renderGallery();
      };
      base.src = imgEl.src;
      // clear drawing after apply
      this.state.annotationCtx.clearRect(0, 0, cnv.width, cnv.height);
    }

    _applyLiveFilter(){
      const video = this.player.el().querySelector('video');
      if (!video) return;
      const filterMap = {
        none: 'none',
        grayscale: 'grayscale(100%)',
        sepia: 'sepia(100%)',
        invert: 'invert(100%)',
        contrast: 'contrast(130%)',
        saturate: 'saturate(140%)',
        blur: 'blur(1px)'
      };
      const custom = (this.options.filters.custom || '').trim();
      const value = custom ? custom : (filterMap[this.options.filters.preset] || 'none');
      video.style.filter = value;
    }
  }

  videojs.registerPlugin('screenshot', function(options){
    const player = this;
    const plugin = new ScreenshotPlugin(player, options || {});

    // Expose API without overriding the plugin function name on player
    player.vjsScreenshot = plugin;

    player.on('dispose', ()=> plugin.dispose());

    return plugin;
  });

})(window, window.videojs);