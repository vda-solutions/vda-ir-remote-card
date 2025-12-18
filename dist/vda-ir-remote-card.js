/**
 * VDA IR Remote Card
 * A custom Lovelace card for controlling IR devices
 */

class VDAIRRemoteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._config = {};
    this._device = null;
    this._commands = [];
    this._showRemote = false;
    this._lastSent = null;
    // Matrix linking
    this._matrixDevice = null;
    this._matrixInputCommands = [];
    this._selectedMatrixInput = null;
    // All controlled devices (for looking up device names for matrix inputs)
    this._allDevices = [];
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._loadDeviceData();
    }
  }

  setConfig(config) {
    if (!config.device_id) {
      throw new Error('Please specify a device_id');
    }
    this._config = {
      device_id: config.device_id,
      name: config.name || null,
      quick_buttons: config.quick_buttons || null,
      show_name: config.show_name !== false,
      ...config,
    };
  }

  static getConfigElement() {
    return document.createElement('vda-ir-remote-card-editor');
  }

  static getStubConfig() {
    return {
      device_id: '',
      name: '',
      quick_buttons: ['power', 'volume_up', 'volume_down', 'mute'],
    };
  }

  async _loadDeviceData() {
    if (!this._hass || !this._config.device_id) return;

    try {
      // Fetch device info from API
      const devicesResp = await fetch('/api/vda_ir_control/devices', {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });

      if (devicesResp.ok) {
        const data = await devicesResp.json();
        this._device = data.devices.find(d => d.device_id === this._config.device_id);
      }

      // Get commands from profile
      if (this._device) {
        await this._loadCommands();
        // Load matrix device if linked
        await this._loadMatrixDevice();
      }

      this._render();
    } catch (e) {
      console.error('Failed to load device data:', e);
      this._render();
    }
  }

  async _loadMatrixDevice() {
    if (!this._device || !this._device.matrix_device_id) {
      this._matrixDevice = null;
      this._matrixInputCommands = [];
      return;
    }

    const matrixId = this._device.matrix_device_id;
    const matrixType = this._device.matrix_device_type;

    try {
      // Load matrix device and all controlled devices in parallel
      const endpoint = matrixType === 'network'
        ? `/api/vda_ir_control/network_devices/${matrixId}`
        : `/api/vda_ir_control/serial_devices/${matrixId}`;

      const [matrixResp, devicesResp] = await Promise.all([
        fetch(endpoint, {
          headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
        }),
        fetch('/api/vda_ir_control/devices', {
          headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
        })
      ]);

      if (matrixResp.ok) {
        this._matrixDevice = await matrixResp.json();
        // Get input commands (is_input_option=true)
        const commands = this._matrixDevice.commands || {};
        let inputCommands = Object.values(commands).filter(cmd => cmd.is_input_option);

        // If device is connected to a specific output, filter to only show commands for that output
        const deviceOutput = this._device.matrix_output;
        if (deviceOutput) {
          // Filter commands that route to this output (command_id pattern: route_in{X}_out{Y})
          const outputSuffix = `_out${deviceOutput}`;
          const filteredCommands = inputCommands.filter(cmd =>
            cmd.command_id && cmd.command_id.includes(outputSuffix)
          );
          // Use filtered if we found matches, otherwise fall back to all (for backwards compatibility)
          if (filteredCommands.length > 0) {
            inputCommands = filteredCommands;
          }
        }

        this._matrixInputCommands = inputCommands;
      }

      if (devicesResp.ok) {
        const devicesData = await devicesResp.json();
        this._allDevices = devicesData.devices || [];
      }
    } catch (e) {
      console.error('Failed to load matrix device:', e);
      this._matrixDevice = null;
      this._matrixInputCommands = [];
    }
  }

  async _loadCommands() {
    if (!this._device) return;

    const profileId = this._device.device_profile_id;

    if (profileId.startsWith('builtin:')) {
      // Fetch builtin profile
      const resp = await fetch(`/api/vda_ir_control/builtin_profiles/${profileId.substring(8)}`, {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (resp.ok) {
        const profile = await resp.json();
        this._commands = Object.keys(profile.codes || {});
        this._deviceType = profile.device_type;
        this._protocol = profile.protocol;
      }
    } else {
      // Fetch custom profile
      const resp = await fetch(`/api/vda_ir_control/profiles/${profileId}`, {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (resp.ok) {
        const profile = await resp.json();
        this._commands = profile.learned_commands || [];
        this._deviceType = profile.device_type;
      }
    }
  }

  _getQuickButtons() {
    if (this._config.quick_buttons) {
      return this._config.quick_buttons.filter(cmd => this._commands.includes(cmd));
    }

    // Default quick buttons based on device type
    const defaults = {
      tv: ['power', 'volume_up', 'volume_down', 'mute'],
      cable_box: ['power', 'guide', 'channel_up', 'channel_down'],
      soundbar: ['power', 'volume_up', 'volume_down', 'mute'],
      streaming: ['power', 'home', 'play_pause', 'back'],
    };

    const defaultBtns = defaults[this._deviceType] || ['power', 'volume_up', 'volume_down'];
    return defaultBtns.filter(cmd => this._commands.includes(cmd));
  }

  /**
   * Get display name for a matrix input command.
   * Shows the assigned device name if available, otherwise the input name.
   * For routing commands like "HDMI 1 → Output 3", we strip the output part since
   * we're already filtering by output.
   */
  _getMatrixInputDisplayName(cmd) {
    if (!this._matrixDevice || !cmd.input_value) {
      // If command name has " → ", take just the first part (input name)
      if (cmd.name && cmd.name.includes(' → ')) {
        return cmd.name.split(' → ')[0];
      }
      return cmd.name;
    }

    // Find the matrix input that matches this command's input_value
    const matrixInputs = this._matrixDevice.matrix_inputs || [];
    const matchingInput = matrixInputs.find(mi => String(mi.index) === String(cmd.input_value));

    if (matchingInput && matchingInput.device_id) {
      // Look up the device name
      const device = this._allDevices.find(d => d.device_id === matchingInput.device_id);
      if (device) {
        return device.name;
      }
    }

    // Fall back to custom input name if set
    if (matchingInput && matchingInput.name) {
      return matchingInput.name;
    }

    // If command name has " → ", take just the first part (input name)
    if (cmd.name && cmd.name.includes(' → ')) {
      return cmd.name.split(' → ')[0];
    }

    return cmd.name;
  }

  _render() {
    const deviceName = this._config.name || (this._device ? this._device.name : 'Unknown Device');
    const deviceIcon = this._getDeviceIcon();
    const quickButtons = this._getQuickButtons();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          overflow: visible;
        }
        .card-content {
          padding: 12px;
        }
        .card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .device-icon {
          font-size: 20px;
        }
        .device-name {
          font-size: 14px;
          font-weight: 500;
          color: var(--primary-text-color);
          flex: 1;
        }
        .device-location {
          font-size: 11px;
          color: var(--secondary-text-color);
        }
        .expand-btn {
          padding: 6px 10px;
          border: none;
          border-radius: 6px;
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 12px;
        }
        .expand-btn:hover {
          background: var(--primary-color);
          color: white;
        }
        .quick-buttons {
          display: flex;
          justify-content: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .quick-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: none;
          background: var(--primary-color);
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.1s;
        }
        .quick-btn svg {
          width: 20px;
          height: 20px;
          fill: currentColor;
        }
        .quick-btn .vol-icon .wave1,
        .quick-btn .vol-icon .wave2,
        .quick-btn .vol-icon .wave3 {
          opacity: 0.3;
          transition: opacity 0.15s;
        }
        .quick-btn .vol-icon.vol-0 .wave1,
        .quick-btn .vol-icon.vol-0 .wave2,
        .quick-btn .vol-icon.vol-0 .wave3 { opacity: 0.15; }
        .quick-btn .vol-icon.vol-1 .wave1 { opacity: 1; }
        .quick-btn .vol-icon.vol-2 .wave1,
        .quick-btn .vol-icon.vol-2 .wave2 { opacity: 1; }
        .quick-btn .vol-icon.vol-3 .wave1,
        .quick-btn .vol-icon.vol-3 .wave2,
        .quick-btn .vol-icon.vol-3 .wave3 { opacity: 1; }
        /* Default states */
        .quick-btn[data-command="volume_up"] .vol-icon .wave1,
        .quick-btn[data-command="volume_up"] .vol-icon .wave2 { opacity: 1; }
        .quick-btn[data-command="volume_down"] .vol-icon .wave1 { opacity: 1; }
        .quick-btn:hover {
          transform: scale(1.1);
        }
        .quick-btn:active {
          transform: scale(0.95);
        }
        .quick-btn.power {
          background: var(--error-color, #f44336);
        }
        .quick-btn.sent {
          background: var(--success-color, #4caf50) !important;
        }

        /* Modal Popup */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
        }
        .modal {
          background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
          border-radius: 16px;
          padding: 16px;
          width: 280px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--divider-color);
        }
        .modal-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--primary-text-color);
        }
        .close-btn {
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 50%;
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 16px;
        }
        .close-btn:hover {
          background: var(--error-color);
          color: white;
        }
        .toast-container {
          height: 32px;
          margin-bottom: 8px;
        }
        .sent-toast {
          background: var(--secondary-background-color);
          color: white;
          padding: 0;
          border-radius: 4px;
          font-size: 11px;
          text-align: center;
          visibility: hidden;
          overflow: hidden;
          position: relative;
          height: 28px;
          line-height: 28px;
        }
        .sent-toast.visible {
          visibility: visible;
        }
        .sent-toast .toast-fill {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          background: var(--success-color, #4caf50);
          transition: none;
          width: 100%;
        }
        .sent-toast.filling .toast-fill {
          transition: width 10s linear;
        }
        .sent-toast.fading .toast-fill {
          animation: pulse-fade 1.5s ease-in-out infinite;
        }
        @keyframes pulse-fade {
          0% { opacity: 1; }
          50% { opacity: 0.15; }
          100% { opacity: 1; }
        }
        .sent-toast .toast-text {
          position: relative;
          z-index: 1;
          padding: 0 12px;
        }
        .remote-section {
          background: var(--secondary-background-color);
          border-radius: 8px;
          padding: 8px;
          margin-bottom: 8px;
        }
        .section-label {
          font-size: 9px;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          text-align: center;
          margin-bottom: 6px;
        }
        .btn {
          border: none;
          border-radius: 6px;
          background: var(--card-background-color, #2c2c2c);
          color: var(--primary-text-color);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.1s;
        }
        .btn:hover {
          background: var(--primary-color);
          color: white;
        }
        .btn:active {
          transform: scale(0.95);
        }
        .btn.power {
          background: var(--error-color, #f44336);
          color: white;
        }
        .power-row {
          display: flex;
          justify-content: center;
          gap: 6px;
        }
        .power-row .btn {
          padding: 8px 14px;
          font-size: 13px;
        }
        .dpad {
          display: grid;
          grid-template-columns: repeat(3, 40px);
          gap: 3px;
          justify-content: center;
        }
        .dpad .btn {
          width: 40px;
          height: 40px;
          font-size: 14px;
        }
        .dpad .btn.ok {
          background: var(--primary-color);
          color: white;
          border-radius: 50%;
        }
        .nav-row {
          display: flex;
          justify-content: center;
          gap: 4px;
          margin-top: 6px;
          flex-wrap: wrap;
        }
        .nav-row .btn {
          padding: 6px 10px;
          font-size: 11px;
        }
        .vol-chan {
          display: flex;
          justify-content: space-around;
        }
        .vol-group, .chan-group {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
        }
        .vol-group .btn, .chan-group .btn {
          width: 44px;
          height: 36px;
          font-size: 16px;
        }
        .numpad {
          display: grid;
          grid-template-columns: repeat(3, 44px);
          gap: 3px;
          justify-content: center;
        }
        .numpad .btn {
          width: 44px;
          height: 38px;
          font-size: 14px;
          font-weight: 600;
        }
        .input-row, .playback-row {
          display: flex;
          justify-content: center;
          gap: 4px;
          flex-wrap: wrap;
        }
        .input-row .btn, .playback-row .btn {
          padding: 6px 8px;
          font-size: 11px;
        }
        /* Matrix input styles */
        .matrix-input-section {
          background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-color) 100%);
          opacity: 0.95;
        }
        .matrix-input-section .section-label {
          color: white;
          opacity: 0.9;
        }
        .matrix-input-row {
          display: flex;
          justify-content: center;
          gap: 4px;
          flex-wrap: wrap;
        }
        .matrix-input-btn {
          padding: 6px 10px;
          font-size: 11px;
          background: rgba(255,255,255,0.2) !important;
          color: white !important;
          border: 1px solid rgba(255,255,255,0.3) !important;
        }
        .matrix-input-btn:hover {
          background: rgba(255,255,255,0.4) !important;
        }
        .matrix-input-btn.selected {
          background: white !important;
          color: var(--primary-color) !important;
          font-weight: 600;
        }
        .not-found {
          padding: 16px;
          text-align: center;
          color: var(--secondary-text-color);
          font-size: 13px;
        }
      </style>

      <ha-card>
        ${this._device ? `
          <div class="card-content">
            <div class="card-header">
              <span class="device-icon">${deviceIcon}</span>
              <div style="flex:1">
                <div class="device-name">${deviceName}</div>
                ${this._device.location ? `<div class="device-location">${this._device.location}</div>` : ''}
              </div>
              <button class="expand-btn" id="open-remote">Remote</button>
            </div>

            <div class="quick-buttons">
              ${quickButtons.map(cmd => `
                <button class="quick-btn ${cmd.includes('power') ? 'power' : ''} ${this._lastSent === cmd ? 'sent' : ''}"
                        data-command="${cmd}" title="${this._formatCommand(cmd)}">
                  ${this._getCommandIcon(cmd)}
                </button>
              `).join('')}
            </div>
          </div>

          ${this._showRemote ? `
            <div class="modal-overlay" id="modal-overlay">
              <div class="modal" onclick="event.stopPropagation()">
                <div class="modal-header">
                  <span class="modal-title">${deviceName}</span>
                  <button class="close-btn" id="close-modal">✕</button>
                </div>

                <div class="toast-container">
                  <div class="sent-toast ${this._lastSent ? 'visible' : ''}">
                    <div class="toast-fill" style="width: ${this._lastSent === 'volume_up' ? '25%' : '100%'}"></div>
                    <span class="toast-text">${this._lastSent ? this._formatCommand(this._lastSent) : ''}</span>
                  </div>
                </div>

                ${this._renderRemoteContent()}
              </div>
            </div>
          ` : ''}
        ` : `
          <div class="not-found">
            Device not found: ${this._config.device_id}<br>
            <small>Create it in the VDA IR Control admin card.</small>
          </div>
        `}
      </ha-card>
    `;

    // Add event listeners
    if (this._device) {
      this.shadowRoot.getElementById('open-remote')?.addEventListener('click', () => {
        this._showRemote = true;
        this._render();
      });
      this.shadowRoot.getElementById('modal-overlay')?.addEventListener('click', () => {
        this._showRemote = false;
        this._lastSent = null;
        this._render();
      });
      this.shadowRoot.getElementById('close-modal')?.addEventListener('click', () => {
        this._showRemote = false;
        this._lastSent = null;
        this._render();
      });

      // Repeatable commands (hold to repeat)
      const repeatableCommands = ['volume_up', 'volume_down', 'channel_up', 'channel_down'];

      this.shadowRoot.querySelectorAll('[data-command]').forEach(btn => {
        const command = btn.dataset.command;

        if (repeatableCommands.includes(command)) {
          // Press and hold support
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this._startRepeat(command);
          });
          btn.addEventListener('mouseup', () => this._stopRepeat());
          btn.addEventListener('mouseleave', () => this._stopRepeat());
          btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._startRepeat(command);
          });
          btn.addEventListener('touchend', () => this._stopRepeat());
          btn.addEventListener('touchcancel', () => this._stopRepeat());
        } else {
          // Normal click
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._sendCommand(command);
          });
        }
      });

      // Matrix input buttons
      this.shadowRoot.querySelectorAll('[data-matrix-command]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._sendMatrixCommand(btn.dataset.matrixCommand);
        });
      });
    }
  }

  _startRepeat(command) {
    this._isHolding = true;
    this._holdCommand = command;
    this._volumeLevel = command === 'volume_up' ? 0 : 3;
    this._holdStartTime = Date.now();

    // Update toast to show holding state (full green initially)
    this._updateToast(command, false);

    // Send immediately
    this._sendCommandSilent(command);
    this._updateVolumeIcon(command);

    // After 250ms, start the slow fill/empty or fade animation
    this._fillDelayTimeout = setTimeout(() => {
      if (this._isHolding) {
        if (command === 'volume_up' || command === 'volume_down') {
          this._startFillAnimation(command);
        } else if (command === 'channel_up' || command === 'channel_down') {
          this._startFadeAnimation();
        }
      }
    }, 250);

    // Then repeat every 200ms while held
    this._repeatInterval = setInterval(() => {
      this._sendCommandSilent(command);
      this._updateVolumeIcon(command);
    }, 200);
  }

  _startFillAnimation(command) {
    const toast = this.shadowRoot.querySelector('.sent-toast');
    if (!toast) return;

    const fillEl = toast.querySelector('.toast-fill');
    if (!fillEl) return;

    // Volume up: fill from 25 to 100, Volume down: empty from 100 to 0
    if (command === 'volume_up') {
      // First set to 25% without transition
      fillEl.style.transition = 'none';
      fillEl.style.width = '25%';
      // Force reflow
      fillEl.offsetHeight;
      // Now add the slow transition and animate to 100%
      toast.classList.add('filling');
      fillEl.style.transition = '';
      fillEl.style.width = '100%';
    } else {
      // First set to 100 without transition
      fillEl.style.transition = 'none';
      fillEl.style.width = '100%';
      // Force reflow
      fillEl.offsetHeight;
      // Now add the slow transition and animate to 0%
      toast.classList.add('filling');
      fillEl.style.transition = '';
      fillEl.style.width = '0%';
    }
  }

  _startFadeAnimation() {
    const toast = this.shadowRoot.querySelector('.sent-toast');
    if (!toast) return;

    toast.classList.add('fading');
  }

  _stopRepeat() {
    if (this._repeatInterval) {
      clearInterval(this._repeatInterval);
      this._repeatInterval = null;
    }

    if (this._fillDelayTimeout) {
      clearTimeout(this._fillDelayTimeout);
      this._fillDelayTimeout = null;
    }

    if (this._isHolding) {
      this._isHolding = false;
      const cmd = this._holdCommand;

      // Reset volume icons before clearing holdCommand
      this._resetVolumeIcons();
      this._holdCommand = null;

      // Reset fill/fade animation
      const toast = this.shadowRoot.querySelector('.sent-toast');
      if (toast) {
        toast.classList.remove('filling');
        toast.classList.remove('fading');
        const fillEl = toast.querySelector('.toast-fill');
        if (fillEl) {
          fillEl.style.width = '100%';
          fillEl.style.opacity = '1';
          fillEl.style.transition = 'none';
        }
      }

      // Show brief "sent" confirmation then clear
      this._updateToast(cmd, false);
      setTimeout(() => {
        this._lastSent = null;
        this._updateToast(null, false);
      }, 500);
    }
  }

  _updateVolumeIcon(command) {
    if (command === 'volume_up') {
      this._volumeLevel = Math.min(3, (this._volumeLevel || 0) + 1);
    } else if (command === 'volume_down') {
      this._volumeLevel = Math.max(0, (this._volumeLevel || 3) - 1);
    }

    // Only update the icon for the button being pressed
    const btn = this.shadowRoot.querySelector(`[data-command="${command}"]`);
    if (btn) {
      const icon = btn.querySelector('.vol-icon');
      if (icon) {
        icon.classList.remove('vol-0', 'vol-1', 'vol-2', 'vol-3');
        icon.classList.add(`vol-${this._volumeLevel}`);
      }
    }
  }

  _resetVolumeIcons() {
    // Reset only the button that was being pressed
    if (this._holdCommand) {
      const btn = this.shadowRoot.querySelector(`[data-command="${this._holdCommand}"]`);
      if (btn) {
        const icon = btn.querySelector('.vol-icon');
        if (icon) {
          icon.classList.remove('vol-0', 'vol-1', 'vol-2', 'vol-3');
        }
      }
    }
  }

  _updateToast(command, isHolding) {
    const toast = this.shadowRoot.querySelector('.sent-toast');
    if (toast) {
      const textEl = toast.querySelector('.toast-text');
      const fillEl = toast.querySelector('.toast-fill');

      if (command) {
        if (textEl) textEl.textContent = this._formatCommand(command);
        // Set fill width BEFORE showing (no transition)
        if (fillEl && !toast.classList.contains('filling')) {
          if (command === 'volume_up') {
            fillEl.style.width = '25%';
          } else {
            fillEl.style.width = '100%';
          }
        }
        toast.classList.add('visible');
      } else {
        toast.classList.remove('visible');
        toast.classList.remove('filling');
        if (fillEl) fillEl.style.width = '100%';
      }
    } else if (command && this._showRemote) {
      // Need to re-render to add toast
      this._lastSent = command;
      this._render();
    }
  }

  async _sendCommandSilent(command) {
    if (!this._device) return;

    // Debounce - prevent rapid fire commands
    const now = Date.now();
    if (this._lastSendTime && now - this._lastSendTime < 150) {
      return;
    }
    this._lastSendTime = now;

    try {
      await this._hass.callService('vda_ir_control', 'send_command', {
        device_id: this._device.device_id,
        command: command,
      });
    } catch (e) {
      console.error('Failed to send command:', e);
    }
  }

  _renderRemoteContent() {
    const commands = this._commands;

    // Group commands
    const powerCmds = commands.filter(c => c.includes('power'));
    const volCmds = commands.filter(c => c.includes('volume') || c === 'mute');
    const chanCmds = commands.filter(c => c.includes('channel'));
    const navCmds = commands.filter(c => ['up', 'down', 'left', 'right', 'enter', 'select', 'back', 'exit', 'menu', 'home', 'guide', 'info'].includes(c));
    const numCmds = commands.filter(c => /^[0-9]$/.test(c));
    const inputCmds = commands.filter(c => c.includes('hdmi') || c.includes('source') || c.includes('input'));
    const playCmds = commands.filter(c => ['play', 'pause', 'play_pause', 'stop', 'rewind', 'fast_forward', 'record', 'replay'].includes(c));

    return `
      <!-- Power -->
      ${powerCmds.length > 0 ? `
        <div class="remote-section">
          <div class="power-row">
            ${powerCmds.map(cmd => `
              <button class="btn power" data-command="${cmd}">
                ${cmd === 'power' ? '⏻' : cmd === 'power_on' ? 'On' : cmd === 'power_off' ? 'Off' : this._formatCommand(cmd)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Matrix Input Selector -->
      ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
        <div class="remote-section matrix-input-section">
          <div class="section-label">Matrix Input (${this._matrixDevice.name})</div>
          <div class="matrix-input-row">
            ${this._matrixInputCommands.map(cmd => `
              <button class="btn matrix-input-btn ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}"
                      data-matrix-command="${cmd.command_id}">
                ${this._getMatrixInputDisplayName(cmd)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Navigation D-Pad -->
      ${navCmds.length > 0 ? `
        <div class="remote-section">
          <div class="dpad">
            <div></div>
            ${navCmds.includes('up') ? `<button class="btn" data-command="up">▲</button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('left') ? `<button class="btn" data-command="left">◀</button>` : '<div></div>'}
            ${navCmds.includes('select') || navCmds.includes('enter') ? `<button class="btn ok" data-command="${navCmds.includes('select') ? 'select' : 'enter'}">OK</button>` : '<div></div>'}
            ${navCmds.includes('right') ? `<button class="btn" data-command="right">▶</button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('down') ? `<button class="btn" data-command="down">▼</button>` : '<div></div>'}
            <div></div>
          </div>
          <div class="nav-row">
            ${navCmds.filter(c => !['up','down','left','right','select','enter'].includes(c)).map(cmd => `
              <button class="btn" data-command="${cmd}">${this._formatCommand(cmd)}</button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Volume & Channel -->
      ${volCmds.length > 0 || chanCmds.length > 0 ? `
        <div class="remote-section">
          <div class="vol-chan">
            ${volCmds.length > 0 ? `
              <div class="vol-group">
                <div class="section-label">Vol</div>
                ${volCmds.includes('volume_up') ? `<button class="btn" data-command="volume_up">+</button>` : ''}
                ${volCmds.includes('mute') ? `<button class="btn" data-command="mute">🔇</button>` : ''}
                ${volCmds.includes('volume_down') ? `<button class="btn" data-command="volume_down">−</button>` : ''}
              </div>
            ` : ''}
            ${chanCmds.length > 0 ? `
              <div class="chan-group">
                <div class="section-label">Ch</div>
                ${chanCmds.includes('channel_up') ? `<button class="btn" data-command="channel_up">▲</button>` : ''}
                ${chanCmds.includes('channel_down') ? `<button class="btn" data-command="channel_down">▼</button>` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Number Pad -->
      ${numCmds.length > 0 ? `
        <div class="remote-section">
          <div class="numpad">
            ${['1','2','3','4','5','6','7','8','9','','0',''].map(n => {
              if (n === '') return '<div></div>';
              return numCmds.includes(n) ? `<button class="btn" data-command="${n}">${n}</button>` : '<div></div>';
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Inputs -->
      ${inputCmds.length > 0 ? `
        <div class="remote-section">
          <div class="section-label">Inputs</div>
          <div class="input-row">
            ${inputCmds.map(cmd => `
              <button class="btn" data-command="${cmd}">${this._formatCommand(cmd)}</button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Playback -->
      ${playCmds.length > 0 ? `
        <div class="remote-section">
          <div class="playback-row">
            ${playCmds.includes('rewind') ? `<button class="btn" data-command="rewind">⏪</button>` : ''}
            ${playCmds.includes('play') ? `<button class="btn" data-command="play">▶</button>` : ''}
            ${playCmds.includes('play_pause') ? `<button class="btn" data-command="play_pause">⏯</button>` : ''}
            ${playCmds.includes('pause') ? `<button class="btn" data-command="pause">⏸</button>` : ''}
            ${playCmds.includes('stop') ? `<button class="btn" data-command="stop">⏹</button>` : ''}
            ${playCmds.includes('fast_forward') ? `<button class="btn" data-command="fast_forward">⏩</button>` : ''}
          </div>
        </div>
      ` : ''}
    `;
  }

  async _sendCommand(command) {
    if (!this._device) return;

    // Debounce - prevent rapid fire commands
    const now = Date.now();
    if (this._lastSendTime && now - this._lastSendTime < 150) {
      return; // Ignore if less than 150ms since last command
    }
    this._lastSendTime = now;

    try {
      await this._hass.callService('vda_ir_control', 'send_command', {
        device_id: this._device.device_id,
        command: command,
      });

      this._lastSent = command;
      this._render();

      // Clear indicator after 1s
      setTimeout(() => {
        if (this._lastSent === command) {
          this._lastSent = null;
          this._render();
        }
      }, 1000);
    } catch (e) {
      console.error('Failed to send command:', e);
    }
  }

  async _sendMatrixCommand(commandId) {
    if (!this._matrixDevice || !this._device) return;

    const matrixType = this._device.matrix_device_type;
    const matrixId = this._device.matrix_device_id;

    try {
      // Call the appropriate service based on matrix type
      const serviceName = matrixType === 'network' ? 'send_network_command' : 'send_serial_command';
      await this._hass.callService('vda_ir_control', serviceName, {
        device_id: matrixId,
        command_id: commandId,
      });

      this._selectedMatrixInput = commandId;
      this._lastSent = `Matrix: ${commandId}`;
      this._render();

      // Clear indicator after 2s (longer for matrix since it's a selection)
      setTimeout(() => {
        if (this._lastSent === `Matrix: ${commandId}`) {
          this._lastSent = null;
          this._render();
        }
      }, 2000);
    } catch (e) {
      console.error('Failed to send matrix command:', e);
    }
  }

  _formatCommand(cmd) {
    const names = {
      power: 'Power', power_on: 'Power On', power_off: 'Power Off',
      volume_up: 'Vol +', volume_down: 'Vol -', mute: 'Mute',
      channel_up: 'Ch +', channel_down: 'Ch -',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right',
      enter: 'OK', select: 'OK', back: 'Back', exit: 'Exit',
      menu: 'Menu', home: 'Home', guide: 'Guide', info: 'Info',
      source: 'Source', hdmi: 'HDMI', hdmi1: 'HDMI 1', hdmi2: 'HDMI 2',
      hdmi3: 'HDMI 3', hdmi4: 'HDMI 4',
      play: 'Play', pause: 'Pause', play_pause: 'Play/Pause',
      stop: 'Stop', rewind: 'Rewind', fast_forward: 'FF',
    };
    return names[cmd] || cmd.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  _getCommandIcon(cmd) {
    const svgs = {
      power: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>`,
      power_on: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>`,
      power_off: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>`,
      volume_up: `<svg class="vol-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path class="wave1" d="M14 12c0-1.1-.6-2.1-1.5-2.6v5.2c.9-.5 1.5-1.5 1.5-2.6z"/><path class="wave2" d="M16 12c0-2-1.2-3.8-3-4.6v1.5c1.2.6 2 1.8 2 3.1s-.8 2.5-2 3.1v1.5c1.8-.8 3-2.6 3-4.6z"/><path class="wave3" d="M19 12c0-3.5-2-6.5-5-8v1.7c2.4 1.4 4 4 4 6.3s-1.6 4.9-4 6.3V20c3-1.5 5-4.5 5-8z"/></svg>`,
      volume_down: `<svg class="vol-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path class="wave1" d="M14 12c0-1.1-.6-2.1-1.5-2.6v5.2c.9-.5 1.5-1.5 1.5-2.6z"/><path class="wave2" d="M16 12c0-2-1.2-3.8-3-4.6v1.5c1.2.6 2 1.8 2 3.1s-.8 2.5-2 3.1v1.5c1.8-.8 3-2.6 3-4.6z"/><path class="wave3" d="M19 12c0-3.5-2-6.5-5-8v1.7c2.4 1.4 4 4 4 6.3s-1.6 4.9-4 6.3V20c3-1.5 5-4.5 5-8z"/></svg>`,
      mute: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
      channel_up: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>`,
      channel_down: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>`,
      up: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>`,
      down: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>`,
      left: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>`,
      right: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`,
      enter: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`,
      select: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`,
      back: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
      exit: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
      menu: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>`,
      home: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`,
      guide: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8H5v2h4V8zm10 0h-8v2h8V8zM9 12H5v2h4v-2zm10 0h-8v2h8v-2z"/></svg>`,
      info: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`,
      source: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zm-10-7l-3-3v2H5v2h3v2l3-3z"/></svg>`,
      play: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
      pause: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
      play_pause: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 5v14l8-7-8-7zm9 0v14h3V5h-3zm5 0v14h3V5h-3z"/></svg>`,
    };
    return svgs[cmd] || `<span style="font-size:14px;font-weight:600">${cmd.charAt(0).toUpperCase()}</span>`;
  }

  _getDeviceIcon() {
    const icons = {
      tv: '📺',
      cable_box: '📦',
      soundbar: '🔊',
      streaming: '📡',
      audio_receiver: '🎵',
      projector: '🎬',
    };
    return icons[this._deviceType] || '📺';
  }

  getCardSize() {
    return 2;
  }
}

// Card Editor
class VDAIRRemoteCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._devices = [];
  }

  set hass(hass) {
    this._hass = hass;
    this._loadDevices();
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  async _loadDevices() {
    if (!this._hass) return;

    try {
      const resp = await fetch('/api/vda_ir_control/devices', {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (resp.ok) {
        const data = await resp.json();
        this._devices = data.devices || [];
        this._render();
      }
    } catch (e) {
      console.error('Failed to load devices:', e);
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        .form-group {
          margin-bottom: 16px;
        }
        label {
          display: block;
          margin-bottom: 4px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        select, input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          background: var(--input-fill-color, var(--secondary-background-color));
          color: var(--primary-text-color);
          font-size: 14px;
        }
        .help-text {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 4px;
        }
      </style>

      <div class="form-group">
        <label>Device</label>
        <select id="device_id">
          <option value="">Select a device...</option>
          ${this._devices.map(d => `
            <option value="${d.device_id}" ${this._config.device_id === d.device_id ? 'selected' : ''}>
              ${d.name} ${d.location ? `(${d.location})` : ''}
            </option>
          `).join('')}
        </select>
        <div class="help-text">Select the IR-controlled device</div>
      </div>

      <div class="form-group">
        <label>Display Name (optional)</label>
        <input type="text" id="name" value="${this._config.name || ''}" placeholder="Override device name">
        <div class="help-text">Leave empty to use device name</div>
      </div>

      <div class="form-group">
        <label>Quick Buttons (optional)</label>
        <input type="text" id="quick_buttons" value="${(this._config.quick_buttons || []).join(', ')}"
               placeholder="power, volume_up, volume_down, mute">
        <div class="help-text">Comma-separated list of commands for quick access buttons</div>
      </div>
    `;

    // Event listeners
    this.shadowRoot.getElementById('device_id').addEventListener('change', (e) => {
      this._updateConfig('device_id', e.target.value);
    });
    this.shadowRoot.getElementById('name').addEventListener('input', (e) => {
      this._updateConfig('name', e.target.value);
    });
    this.shadowRoot.getElementById('quick_buttons').addEventListener('input', (e) => {
      const buttons = e.target.value.split(',').map(s => s.trim()).filter(s => s);
      this._updateConfig('quick_buttons', buttons.length > 0 ? buttons : null);
    });
  }

  _updateConfig(key, value) {
    this._config = { ...this._config, [key]: value };
    const event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

customElements.define('vda-ir-remote-card', VDAIRRemoteCard);
customElements.define('vda-ir-remote-card-editor', VDAIRRemoteCardEditor);

// Register card with HA
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'vda-ir-remote-card',
  name: 'VDA IR Remote',
  description: 'Control IR devices with a remote-style interface',
  preview: true,
  documentationURL: 'https://github.com/vda-solutions/vda-ir-control',
});
