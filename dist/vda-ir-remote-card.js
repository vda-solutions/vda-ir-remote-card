/**
 * VDA IR Remote Card
 * A custom Lovelace card for controlling IR devices
 * @version 1.9.0
 */

// Global data cache - shared across all card instances to avoid duplicate API calls
const VDADataCache = {
  _data: {},
  _loading: {},
  _ttl: 5000, // Cache for 5 seconds

  async fetch(key, fetchFn) {
    const now = Date.now();
    // Return cached data if fresh
    if (this._data[key] && (now - this._data[key].timestamp) < this._ttl) {
      return this._data[key].value;
    }
    // If already loading, wait for it
    if (this._loading[key]) {
      return this._loading[key];
    }
    // Start loading
    this._loading[key] = fetchFn().then(value => {
      this._data[key] = { value, timestamp: Date.now() };
      delete this._loading[key];
      return value;
    }).catch(e => {
      delete this._loading[key];
      throw e;
    });
    return this._loading[key];
  },

  invalidate(key) {
    delete this._data[key];
  },

  invalidateAll() {
    this._data = {};
  }
};

// Global query queue to prevent multiple cards from overwhelming the serial device
const VDAMatrixQueryQueue = {
  _queue: [],
  _processing: false,
  _lastQueryTime: 0,
  _minInterval: 300, // Minimum ms between queries

  async enqueue(queryFn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ queryFn, resolve, reject });
      this._processQueue();
    });
  },

  async _processQueue() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const { queryFn, resolve, reject } = this._queue.shift();

      // Wait for minimum interval since last query
      const now = Date.now();
      const elapsed = now - this._lastQueryTime;
      if (elapsed < this._minInterval) {
        await new Promise(r => setTimeout(r, this._minInterval - elapsed));
      }

      try {
        this._lastQueryTime = Date.now();
        const result = await queryFn();
        resolve(result);
      } catch (e) {
        reject(e);
      }
    }

    this._processing = false;
  }
};

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
    // Source device (the device on the selected matrix input)
    this._sourceDevice = null;
    this._sourceCommands = [];
    // Device groups
    this._isDeviceGroup = false;
    this._deviceGroup = null;
    this._groupMemberDevices = [];
    // HA Devices
    this._haDevices = [];
    this._sourceIsHADevice = false;
    this._sourceMediaPlayerEntity = null;
    // Multiple output devices (TVs sharing same matrix output via splitter)
    this._outputDevices = [];
    // TV devices configured in card config (for power buttons)
    this._tvDevices = [];
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._loadDeviceData();
    }

    // Re-render if media_player state changed (for now playing info)
    if (this._sourceMediaPlayerEntity && oldHass) {
      const oldState = oldHass.states[this._sourceMediaPlayerEntity];
      const newState = hass.states[this._sourceMediaPlayerEntity];
      if (oldState && newState) {
        // Compare relevant attributes
        const oldAttrs = oldState.attributes || {};
        const newAttrs = newState.attributes || {};
        if (oldState.state !== newState.state ||
            oldAttrs.media_title !== newAttrs.media_title ||
            oldAttrs.media_channel !== newAttrs.media_channel ||
            oldAttrs.media_series_title !== newAttrs.media_series_title) {
          this._render();
        }
      }
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
      const authHeader = { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` };

      // Use global cache - only first card makes actual API calls, others get cached data
      const [groupsData, devicesData, serialData, haData] = await Promise.all([
        VDADataCache.fetch('device_groups', async () => {
          const resp = await fetch('/api/vda_ir_control/device_groups', { headers: authHeader });
          return resp.ok ? resp.json() : { groups: [] };
        }),
        VDADataCache.fetch('devices', async () => {
          const resp = await fetch('/api/vda_ir_control/devices', { headers: authHeader });
          return resp.ok ? resp.json() : { devices: [] };
        }),
        VDADataCache.fetch('serial_devices', async () => {
          const resp = await fetch('/api/vda_ir_control/serial_devices', { headers: authHeader });
          return resp.ok ? resp.json() : { devices: [] };
        }),
        VDADataCache.fetch('ha_devices', async () => {
          const resp = await fetch('/api/vda_ir_control/ha_devices', { headers: authHeader });
          return resp.ok ? resp.json() : { devices: [] };
        }),
      ]);

      // Process groups
      const groups = groupsData.groups || [];
      this._deviceGroup = groups.find(g => g.group_id === this._config.device_id);
      this._isDeviceGroup = !!this._deviceGroup;

      // Process devices
      const allDevices = devicesData.devices || [];
      this._allDevices = allDevices;
      if (!this._isDeviceGroup) {
        this._device = allDevices.find(d => d.device_id === this._config.device_id);
      }

      // Process serial devices
      const serialDevices = serialData.devices || [];

      // Process HA devices
      this._haDevices = haData.devices || [];

      // If this is a device group, load member device info
      if (this._isDeviceGroup && this._deviceGroup.members) {
        this._groupMemberDevices = this._deviceGroup.members.map(member => {
          if (member.device_type === 'controlled') {
            const device = allDevices.find(d => d.device_id === member.device_id);
            return device ? { ...device, member_type: 'controlled' } : null;
          } else if (member.device_type === 'serial') {
            const device = serialDevices.find(d => d.device_id === member.device_id);
            return device ? { ...device, member_type: 'serial' } : null;
          }
          return null;
        }).filter(d => d !== null);
      }

      // Get commands from profile (only for regular devices)
      if (this._device && !this._isDeviceGroup) {
        await this._loadCommands();
        // Load matrix device if linked
        await this._loadMatrixDevice();

        // Find all devices sharing the same matrix output (for HDMI splitters)
        if (this._device.matrix_port && this._device.matrix_device_id) {
          this._outputDevices = allDevices.filter(d =>
            d.device_id !== this._device.device_id &&
            d.matrix_port === this._device.matrix_port &&
            d.matrix_device_id === this._device.matrix_device_id
          );
        }

        // Load TV devices from card config (for power buttons on splitter outputs)
        if (this._config.tv_devices && Array.isArray(this._config.tv_devices)) {
          this._tvDevices = this._config.tv_devices
            .map(tvId => allDevices.find(d => d.device_id === tvId))
            .filter(d => d !== null && d !== undefined);
        }
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
      // Only fetch matrix device details (devices and HA devices already loaded)
      const endpoint = matrixType === 'network'
        ? `/api/vda_ir_control/network_devices/${matrixId}`
        : `/api/vda_ir_control/serial_devices/${matrixId}`;

      const matrixResp = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
      });

      if (matrixResp.ok) {
        this._matrixDevice = await matrixResp.json();

        // Check if matrix has pre-defined input commands (is_input_option=true)
        const commands = this._matrixDevice.commands || {};
        let inputCommands = Object.values(commands).filter(cmd => cmd.is_input_option);

        // If device is connected to a specific output, filter to only show commands for that output
        const deviceOutput = this._device.matrix_port;
        if (deviceOutput && inputCommands.length > 0) {
          // Filter commands that route to this output (command_id pattern: route_in{X}_out{Y})
          const outputSuffix = `_out${deviceOutput}`;
          const filteredCommands = inputCommands.filter(cmd =>
            cmd.command_id && cmd.command_id.includes(outputSuffix)
          );
          if (filteredCommands.length > 0) {
            inputCommands = filteredCommands;
          }
        }

        // If no pre-defined input commands, generate from matrix_inputs
        if (inputCommands.length === 0) {
          const matrixInputs = this._matrixDevice.matrix_inputs || [];
          // Filter out disabled inputs
          inputCommands = matrixInputs
            .filter(input => input.enabled !== false)
            .map(input => ({
              command_id: `route_input_${input.index}`,
              name: input.name || `Input ${input.index}`,
              input_value: String(input.index),
              device_id: input.device_id,  // May have a linked source device
              _generated: true
            }));
        }

        this._matrixInputCommands = inputCommands;
      }

      // _allDevices and _haDevices already loaded in _loadDeviceData - no need to fetch again
      // Just log if they're not available for debugging
      if (!this._allDevices) {
        console.warn('_allDevices not loaded');
      }
      if (!this._haDevices) {
        console.warn('_haDevices not loaded');
        this._haDevices = [];
      }

      // Query current matrix routing state (non-blocking - don't wait for it)
      if (this._matrixDevice && this._device.matrix_port) {
        // Don't await - let it run in background and re-render when done
        this._queryMatrixRouting().then(() => {
          if (this._selectedMatrixInput) {
            this._render();
          }
        }).catch(e => console.warn('Matrix query failed:', e));
      }
    } catch (e) {
      console.error('Failed to load matrix device:', e);
      this._matrixDevice = null;
      this._matrixInputCommands = [];
    }
  }

  async _queryMatrixRouting() {
    // Query the matrix for current routing using configured template
    if (!this._matrixDevice || !this._device.matrix_port) return;

    const matrixType = this._device.matrix_device_type;
    if (matrixType !== 'serial') return; // Only serial matrices for now

    // Use query template if configured, otherwise skip
    const queryTemplate = this._matrixDevice.query_template;
    if (!queryTemplate) {
      return;
    }

    const outputNum = this._device.matrix_port;
    const matrixId = this._device.matrix_device_id;
    const cacheKey = `matrix_routing_${matrixId}_${outputNum}`;
    const queryCmd = queryTemplate.replace('{output}', outputNum);

    try {
      // Use cache with queue to prevent duplicate queries
      const result = await VDADataCache.fetch(cacheKey, async () => {
        return VDAMatrixQueryQueue.enqueue(async () => {
          const resp = await fetch(`/api/vda_ir_control/serial_devices/${matrixId}/send`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              payload: queryCmd,
              format: 'text',
              line_ending: 'none',
              wait_for_response: true,
              timeout: 1.0,  // Reduced from 2s
            }),
          });
          if (resp.ok) {
            return await resp.json();
          }
          return null;
        });
      });

      if (result) {
        // Parse response to extract input number
        // OREI format: "av outY inX" or "input X -> output Y" or just "X"
        if (result && result.response) {
          const response = String(result.response).trim();

          // Try OREI format first: "av out1 in3" -> input is 3
          let inputMatch = response.match(/in(\d+)/i);
          // Try "input X" format
          if (!inputMatch) inputMatch = response.match(/input\s*(\d+)/i);
          // Try just a number at the end
          if (!inputMatch) inputMatch = response.match(/(\d+)\s*$/);
          // Try any number
          if (!inputMatch) inputMatch = response.match(/(\d+)/);

          if (inputMatch) {
            const inputNum = inputMatch[1];
            // Find the corresponding command
            const matchingCmd = this._matrixInputCommands.find(cmd =>
              cmd.input_value === inputNum || cmd.input_value === String(inputNum)
            );
            if (matchingCmd) {
              this._selectedMatrixInput = matchingCmd.command_id;
              // Load source device for now playing info
              await this._loadSourceDevice();
              // Re-render to update the dropdown
              this._render();
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to query matrix routing:', e);
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

  async _loadSourceDevice() {
    // Load the device assigned to the currently selected matrix input
    this._sourceDevice = null;
    this._sourceCommands = [];
    this._sourceIsHADevice = false;

    if (!this._matrixDevice || !this._selectedMatrixInput) return;

    // Find the input command to get the input index
    const inputCmd = this._matrixInputCommands.find(c => c.command_id === this._selectedMatrixInput);
    if (!inputCmd) return;

    const inputIndex = inputCmd.input_value;

    // Find the matrix input with this index
    const matrixInputs = this._matrixDevice.matrix_inputs || [];
    const matrixInput = matrixInputs.find(i => String(i.index) === String(inputIndex));
    if (!matrixInput || !matrixInput.device_id) return;

    // First check if this is an HA device
    const haDevice = this._haDevices.find(d => d.device_id === matrixInput.device_id);
    if (haDevice) {
      this._sourceDevice = haDevice;
      this._sourceIsHADevice = true;

      // Determine media_player entity for now playing info
      // Use explicit media_player_entity_id if set, otherwise try to auto-detect
      if (haDevice.media_player_entity_id) {
        this._sourceMediaPlayerEntity = haDevice.media_player_entity_id;
      } else if (haDevice.entity_id && haDevice.entity_id.startsWith('remote.')) {
        // Auto-detect: try media_player with same suffix (e.g., remote.g -> media_player.g)
        const suffix = haDevice.entity_id.replace('remote.', '');
        const possibleMediaPlayer = `media_player.${suffix}`;
        if (this._hass.states[possibleMediaPlayer]) {
          this._sourceMediaPlayerEntity = possibleMediaPlayer;
        }
      } else if (haDevice.entity_id && haDevice.entity_id.startsWith('media_player.')) {
        // Entity is already a media_player
        this._sourceMediaPlayerEntity = haDevice.entity_id;
      } else {
        this._sourceMediaPlayerEntity = null;
      }

      // Load commands for this HA device family
      try {
        const resp = await fetch(`/api/vda_ir_control/ha_devices/${haDevice.device_id}/commands`, {
          headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          // Normalize commands to lowercase for consistent matching
          this._sourceCommands = (data.commands || []).map(c => c.toLowerCase());
          this._sourceDeviceType = haDevice.device_family;
        }
      } catch (e) {
        console.error('Failed to load HA device commands:', e);
        // Fallback: use common commands based on device family
        this._sourceCommands = ['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'back', 'play_pause', 'power'];
      }
      return;
    }

    // Find the device in our cached IR devices
    const sourceDevice = this._allDevices.find(d => d.device_id === matrixInput.device_id);
    if (!sourceDevice) return;

    this._sourceDevice = sourceDevice;
    this._sourceIsHADevice = false;
    this._sourceMediaPlayerEntity = null;

    // Load the source device's commands from its profile
    const profileId = sourceDevice.device_profile_id;
    if (!profileId) return;

    try {
      if (profileId.startsWith('builtin:')) {
        const resp = await fetch(`/api/vda_ir_control/builtin_profiles/${profileId.substring(8)}`, {
          headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
        });
        if (resp.ok) {
          const profile = await resp.json();
          this._sourceCommands = Object.keys(profile.codes || {});
          this._sourceDeviceType = profile.device_type;
        }
      } else {
        const resp = await fetch(`/api/vda_ir_control/profiles/${profileId}`, {
          headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
        });
        if (resp.ok) {
          const profile = await resp.json();
          this._sourceCommands = profile.learned_commands || [];
          this._sourceDeviceType = profile.device_type;
        }
      }
    } catch (e) {
      console.error('Failed to load source device commands:', e);
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
          padding: 24px 16px 16px 16px;
        }
        .card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .device-icon {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .device-icon svg {
          width: 24px;
          height: 24px;
          fill: currentColor;
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
        .matrix-input-select {
          padding: 8px 12px;
          font-size: 13px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 8px;
          background: var(--card-background-color, white);
          color: var(--primary-text-color);
          cursor: pointer;
          min-width: 140px;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          padding-right: 30px;
        }
        .matrix-input-select:focus {
          outline: none;
          border-color: var(--primary-color);
          box-shadow: 0 0 0 2px rgba(var(--rgb-primary-color, 33, 150, 243), 0.2);
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
        .now-playing {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: var(--secondary-background-color);
          border-radius: 8px;
          margin-bottom: 12px;
        }
        .now-playing-image {
          width: 60px;
          height: 60px;
          border-radius: 6px;
          object-fit: cover;
          background: var(--card-background-color);
        }
        .now-playing-info {
          flex: 1;
          min-width: 0;
        }
        .now-playing-title {
          font-weight: 600;
          font-size: 14px;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .now-playing-subtitle {
          font-size: 12px;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 2px;
        }
        .now-playing-channel {
          font-size: 11px;
          color: var(--primary-color);
          margin-top: 4px;
        }
        .now-playing-compact {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 0;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          margin-top: 8px;
        }
        .now-playing-image-compact {
          width: 40px;
          height: 40px;
          border-radius: 4px;
          object-fit: cover;
        }
        .now-playing-info-compact {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .now-playing-title-compact {
          font-size: 13px;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .now-playing-channel-compact {
          font-size: 11px;
          color: var(--secondary-text-color);
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
        .dual-power {
          gap: 12px;
        }
        .dual-power .btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 10px 16px;
          min-width: 70px;
        }
        .dual-power .power-icon {
          font-size: 18px;
        }
        .dual-power .power-label {
          font-size: 10px;
          margin-top: 4px;
          opacity: 0.9;
        }
        .dual-power .tv-power {
          background: var(--error-color, #f44336);
        }
        .dual-power .source-power {
          background: var(--primary-color, #03a9f4);
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
        .group-card {
          padding: 24px 16px 16px 16px;
        }
        .group-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .group-icon {
          display: flex;
          align-items: center;
        }
        .group-icon svg {
          width: 20px;
          height: 20px;
          fill: currentColor;
        }
        .group-name {
          font-size: 14px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .group-members-inline {
          font-size: 11px;
          color: var(--secondary-text-color);
        }
        .group-power-btn-small {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: none;
          background: var(--error-color, #f44336);
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          transition: all 0.2s;
        }
        .group-power-btn-small:hover {
          transform: scale(1.1);
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .group-power-btn-small.sending {
          animation: pulse 0.5s infinite;
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        .group-status {
          font-size: 11px;
          text-align: center;
          margin-top: 8px;
          padding: 6px;
          border-radius: 6px;
          background: var(--secondary-background-color);
        }
        .quick-btn.compact {
          width: 36px;
          height: 36px;
          margin-right: 6px;
        }
        .quick-btn.compact svg {
          width: 16px;
          height: 16px;
        }
        .matrix-input-select.compact {
          padding: 6px 8px;
          font-size: 12px;
          margin-right: 6px;
          max-width: 100px;
        }
      </style>

      <ha-card>
        ${this._isDeviceGroup && this._deviceGroup ? `
          <div class="group-card">
            <div class="group-header">
              <span class="group-icon"><svg viewBox="0 0 24 24"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg></span>
              <div style="flex:1">
                <div class="group-name">${this._config.name || this._deviceGroup.name}</div>
                <div class="group-members-inline">${this._groupMemberDevices.length} device${this._groupMemberDevices.length !== 1 ? 's' : ''}</div>
              </div>
              <button class="group-power-btn-small ${this._isSendingGroupPower ? 'sending' : ''}" id="group-power-btn" title="Power All Devices">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
              </button>
            </div>
            ${this._groupPowerStatus ? `
              <div class="group-status">${this._groupPowerStatus}</div>
            ` : ''}
          </div>
        ` : this._device ? `
          <div class="card-content">
            <div class="card-header">
              <span class="device-icon">${deviceIcon}</span>
              <div style="flex:1">
                <div class="device-name">${deviceName}</div>
                ${this._device.location ? `<div class="device-location">${this._device.location}</div>` : ''}
              </div>
              ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
                ${this._commands.includes('power') ? `
                  <button class="quick-btn power compact ${this._lastSent === 'power_' + this._device.device_id ? 'sent' : ''}"
                          data-command="power" data-device-id="${this._device.device_id}" title="Power ${this._device.name}">
                    ${this._getCommandIcon('power')}
                  </button>
                ` : ''}
                ${this._tvDevices.map(tv => `
                  <button class="quick-btn power compact ${this._lastSent === 'power_tv_' + tv.device_id ? 'sent' : ''}"
                          data-command="power" data-tv-device-id="${tv.device_id}" title="Power ${tv.name}">
                    ${this._getCommandIcon('power')}
                  </button>
                `).join('')}
                <select class="matrix-input-select compact" id="matrix-input-dropdown">
                  <option value="" disabled ${!this._selectedMatrixInput ? 'selected' : ''}>Input</option>
                  ${this._matrixInputCommands.map(cmd => `
                    <option value="${cmd.command_id}" ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}>
                      ${this._getMatrixInputDisplayName(cmd)}
                    </option>
                  `).join('')}
                </select>` : `
                ${quickButtons.map(cmd => `
                  <button class="quick-btn compact ${cmd.includes('power') ? 'power' : ''} ${this._lastSent === cmd ? 'sent' : ''}"
                          data-command="${cmd}" title="${this._formatCommand(cmd)}">
                    ${this._getCommandIcon(cmd)}
                  </button>
                `).join('')}
              `}
              <button class="expand-btn" id="open-remote">Remote</button>
            </div>

            ${this._renderCompactNowPlaying()}

            ${this._showRemote ? `
              <div class="modal-overlay" id="modal-overlay">
                <div class="modal" onclick="event.stopPropagation()">
                  <div class="modal-header">
                    <span class="modal-title">${this._sourceDevice ? `${deviceName} → ${this._sourceDevice.name}` : deviceName}</span>
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
          </div>
        ` : `
          <div class="not-found">
            Device or group not found: ${this._config.device_id}<br>
            <small>Create it in the VDA IR Control admin card.</small>
          </div>
        `}
      </ha-card>
    `;

    // Add event listeners for device groups
    if (this._isDeviceGroup && this._deviceGroup) {
      this.shadowRoot.getElementById('group-power-btn')?.addEventListener('click', () => {
        this._sendGroupPowerCommand();
      });
    }

    // Add event listeners for regular devices
    if (this._device) {
      this.shadowRoot.getElementById('open-remote')?.addEventListener('click', async () => {
        // If linked to matrix, load the source device's commands
        if (this._matrixDevice && this._selectedMatrixInput) {
          await this._loadSourceDevice();
        }
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
      const repeatableCommands = ['volume_up', 'volume_down', 'channel_up', 'channel_down', 'chanup', 'chandown'];

      this.shadowRoot.querySelectorAll('[data-command]').forEach(btn => {
        const command = btn.dataset.command;
        const isSource = btn.dataset.source === 'true';

        if (repeatableCommands.includes(command)) {
          // Press and hold support - always use TV for volume
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
            const targetDeviceId = btn.dataset.deviceId;
            const tvDeviceId = btn.dataset.tvDeviceId;
            if (tvDeviceId) {
              // Send to specific TV device (from tv_devices config)
              this._sendCommandToDevice(command, tvDeviceId);
              this._lastSent = 'power_tv_' + tvDeviceId;
              this._render();
              setTimeout(() => { this._lastSent = null; this._render(); }, 1000);
            } else if (targetDeviceId) {
              // Send to specific device (e.g., additional TV on same output)
              this._sendCommandToDevice(command, targetDeviceId);
              this._lastSent = command + '_' + targetDeviceId;
              this._render();
              setTimeout(() => { this._lastSent = null; this._render(); }, 1000);
            } else if (isSource && this._sourceDevice) {
              // Send to source device
              this._sendCommandToDevice(command, this._sourceDevice.device_id);
            } else if (this._sourceDevice && !['volume_up', 'volume_down', 'mute'].includes(command)) {
              // In matrix mode, non-volume commands go to source device
              this._sendCommandToDevice(command, this._sourceDevice.device_id);
            } else {
              // Send to TV device
              this._sendCommand(command);
            }
          });
        }
      });

      // Matrix input buttons (in modal)
      this.shadowRoot.querySelectorAll('[data-matrix-command]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._sendMatrixCommand(btn.dataset.matrixCommand);
        });
      });

      // Matrix input dropdown (in compact view)
      const matrixDropdown = this.shadowRoot.getElementById('matrix-input-dropdown');
      if (matrixDropdown) {
        // Explicitly set the value to ensure correct selection
        if (this._selectedMatrixInput) {
          matrixDropdown.value = this._selectedMatrixInput;
        }
        matrixDropdown.addEventListener('change', (e) => {
          const commandId = e.target.value;
          if (commandId) {
            this._sendMatrixCommand(commandId);
          }
        });
      }
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
        } else if (command === 'channel_up' || command === 'channel_down' || command === 'chanup' || command === 'chandown') {
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
    // Check if we have a source device (matrix mode)
    const hasSourceDevice = this._matrixDevice && this._sourceDevice && this._sourceCommands.length > 0;

    // Use source device commands for navigation/playback, TV for volume
    const commands = hasSourceDevice ? this._sourceCommands : this._commands;
    const tvCommands = this._commands; // Always TV commands for volume

    // Group commands
    const powerCmds = commands.filter(c => c.includes('power'));
    const tvPowerCmds = tvCommands.filter(c => c.includes('power'));
    const volCmds = tvCommands.filter(c => c.includes('volume') || c === 'mute'); // Volume from TV
    const chanCmds = commands.filter(c => c.includes('channel') || c.includes('chan'));
    const navCmds = commands.filter(c => ['up', 'down', 'left', 'right', 'enter', 'select', 'center', 'back', 'exit', 'menu', 'home', 'guide', 'info'].includes(c));
    const numCmds = commands.filter(c => /^[0-9]$/.test(c));
    const inputCmds = commands.filter(c => c.includes('hdmi') || c.includes('source') || c.includes('input'));
    const playCmds = commands.filter(c => ['play', 'pause', 'play_pause', 'stop', 'rewind', 'fast_forward', 'record', 'replay', 'ffwd', 'rew', 'next', 'previous', 'advance'].includes(c));

    // Get now playing info for HA source device
    const nowPlaying = this._getNowPlayingInfo();

    return `
      <!-- Now Playing Info -->
      ${nowPlaying ? `
        <div class="now-playing">
          ${nowPlaying.entity_picture ? `
            <img src="${nowPlaying.entity_picture}" class="now-playing-image" alt="">
          ` : ''}
          <div class="now-playing-info">
            <div class="now-playing-title">${nowPlaying.media_title || ''}</div>
            ${nowPlaying.media_series_title ? `<div class="now-playing-subtitle">${nowPlaying.media_series_title}</div>` : ''}
            ${nowPlaying.media_channel ? `<div class="now-playing-channel">${nowPlaying.media_channel}</div>` : ''}
          </div>
        </div>
      ` : ''}
      <!-- Power - Dual buttons when in matrix mode -->
      ${hasSourceDevice ? `
        <div class="remote-section">
          <div class="power-row dual-power">
            <button class="btn power tv-power" data-command="power" data-device-id="${this._device.device_id}">
              <span class="power-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg></span>
              <span class="power-label">${this._device.name.substring(0, 8)}</span>
            </button>
            ${this._tvDevices.map(tv => `
              <button class="btn power tv-power" data-command="power" data-tv-device-id="${tv.device_id}">
                <span class="power-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg></span>
                <span class="power-label">${tv.name.substring(0, 8)}</span>
              </button>
            `).join('')}
            ${powerCmds.includes('power') ? `
              <button class="btn power source-power" data-command="power" data-source="true">
                <span class="power-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg></span>
                <span class="power-label">${this._sourceDevice.name.substring(0, 8)}</span>
              </button>
            ` : ''}
          </div>
        </div>
      ` : powerCmds.length > 0 ? `
        <div class="remote-section">
          <div class="power-row">
            ${powerCmds.map(cmd => `
              <button class="btn power" data-command="${cmd}">
                ${cmd === 'power' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>' : cmd === 'power_on' ? 'On' : cmd === 'power_off' ? 'Off' : this._formatCommand(cmd)}
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
            ${navCmds.includes('up') ? `<button class="btn" data-command="up"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('left') ? `<button class="btn" data-command="left"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>` : '<div></div>'}
            ${navCmds.includes('select') || navCmds.includes('enter') || navCmds.includes('center') ? `<button class="btn ok" data-command="${navCmds.includes('select') ? 'select' : navCmds.includes('center') ? 'center' : 'enter'}">OK</button>` : '<div></div>'}
            ${navCmds.includes('right') ? `<button class="btn" data-command="right"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('down') ? `<button class="btn" data-command="down"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>` : '<div></div>'}
            <div></div>
          </div>
          <div class="nav-row">
            ${navCmds.filter(c => !['up','down','left','right','select','enter','center'].includes(c)).map(cmd => `
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
                ${volCmds.includes('mute') ? `<button class="btn" data-command="mute"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg></button>` : ''}
                ${volCmds.includes('volume_down') ? `<button class="btn" data-command="volume_down">−</button>` : ''}
              </div>
            ` : ''}
            ${chanCmds.length > 0 ? `
              <div class="chan-group">
                <div class="section-label">Ch</div>
                ${chanCmds.some(c => c === 'channel_up' || c === 'chanup') ? `<button class="btn" data-command="${chanCmds.find(c => c === 'channel_up' || c === 'chanup')}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>` : ''}
                ${chanCmds.some(c => c === 'channel_down' || c === 'chandown') ? `<button class="btn" data-command="${chanCmds.find(c => c === 'channel_down' || c === 'chandown')}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>` : ''}
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

      <!-- Playback -->
      ${playCmds.length > 0 ? `
        <div class="remote-section">
          <div class="playback-row">
            ${playCmds.some(c => ['rewind', 'rew', 'previous', 'replay'].includes(c)) ? `<button class="btn" data-command="${playCmds.find(c => ['rewind', 'rew', 'previous', 'replay'].includes(c))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>` : ''}
            ${playCmds.includes('play') ? `<button class="btn" data-command="play"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
            ${playCmds.includes('play_pause') ? `<button class="btn" data-command="play_pause"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
            ${playCmds.includes('pause') ? `<button class="btn" data-command="pause"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button>` : ''}
            ${playCmds.includes('stop') ? `<button class="btn" data-command="stop"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h12v12H6z"/></svg></button>` : ''}
            ${playCmds.some(c => ['fast_forward', 'ffwd', 'next', 'advance'].includes(c)) ? `<button class="btn" data-command="${playCmds.find(c => ['fast_forward', 'ffwd', 'next', 'advance'].includes(c))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg></button>` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Inputs - Always at bottom. Show matrix inputs if linked to matrix, otherwise show IR input commands -->
      ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
        <div class="remote-section matrix-input-section">
          <div class="section-label">Inputs</div>
          <div class="matrix-input-row">
            ${this._matrixInputCommands.map(cmd => `
              <button class="btn matrix-input-btn ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}"
                      data-matrix-command="${cmd.command_id}">
                ${this._getMatrixInputDisplayName(cmd)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : inputCmds.length > 0 ? `
        <div class="remote-section">
          <div class="section-label">Inputs</div>
          <div class="input-row">
            ${inputCmds.map(cmd => `
              <button class="btn" data-command="${cmd}">${this._formatCommand(cmd)}</button>
            `).join('')}
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

  async _sendGroupPowerCommand() {
    if (!this._deviceGroup || !this._groupMemberDevices.length) return;

    this._isSendingGroupPower = true;
    this._groupPowerStatus = 'Sending power commands...';
    this._render();

    const delay = this._deviceGroup.sequence_delay_ms || 20;
    let successCount = 0;

    for (let i = 0; i < this._groupMemberDevices.length; i++) {
      const member = this._groupMemberDevices[i];
      this._groupPowerStatus = `Sending to ${member.name} (${i + 1}/${this._groupMemberDevices.length})`;
      this._render();

      try {
        if (member.member_type === 'controlled') {
          // IR device - send power command
          await this._hass.callService('vda_ir_control', 'send_command', {
            device_id: member.device_id,
            command: 'power',
          });
          successCount++;
        } else if (member.member_type === 'serial') {
          // Serial device - find and send power command
          const powerCmd = Object.entries(member.commands || {}).find(([id, cmd]) =>
            id === 'power' || cmd.name?.toLowerCase() === 'power'
          );
          if (powerCmd) {
            await this._hass.callService('vda_ir_control', 'send_serial_command', {
              device_id: member.device_id,
              command_id: powerCmd[0],
            });
            successCount++;
          }
        }
      } catch (e) {
        console.error(`Failed to send power to ${member.name}:`, e);
      }

      // Wait for delay before next device (except for last one)
      if (i < this._groupMemberDevices.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this._isSendingGroupPower = false;
    this._groupPowerStatus = `Sent to ${successCount}/${this._groupMemberDevices.length} devices`;
    this._render();

    // Clear status after 3 seconds
    setTimeout(() => {
      this._groupPowerStatus = null;
      this._render();
    }, 3000);
  }

  async _sendCommandToDevice(command, deviceId) {
    if (!deviceId) return;

    // Debounce
    const now = Date.now();
    if (this._lastSendTime && now - this._lastSendTime < 150) {
      return;
    }
    this._lastSendTime = now;

    try {
      // Check if this is an HA device
      const isHADevice = this._sourceIsHADevice && this._sourceDevice?.device_id === deviceId;

      if (isHADevice) {
        // Use HA command service for HA devices
        await this._hass.callService('vda_ir_control', 'send_ha_command', {
          device_id: deviceId,
          command: command,
        });
      } else {
        // Use regular IR command service
        await this._hass.callService('vda_ir_control', 'send_command', {
          device_id: deviceId,
          command: command,
        });
      }

      this._lastSent = command;
      this._render();

      setTimeout(() => {
        if (this._lastSent === command) {
          this._lastSent = null;
          this._render();
        }
      }, 1000);
    } catch (e) {
      console.error('Failed to send command to device:', e);
    }
  }

  async _sendMatrixCommand(commandId) {
    if (!this._matrixDevice || !this._device) return;

    const matrixType = this._device.matrix_device_type;
    const matrixId = this._device.matrix_device_id;

    try {
      // Find the command object to check if it's generated
      const cmd = this._matrixInputCommands.find(c => c.command_id === commandId);

      if (cmd && cmd._generated && matrixType === 'serial') {
        // Generated command for serial matrix - use routing template
        const template = this._matrixDevice.routing_template;
        if (!template) {
          return;
        }

        const inputNum = cmd.input_value;
        const outputNum = this._device.matrix_port;
        // Replace placeholders in template
        const rawCommand = template
          .replace('{input}', inputNum)
          .replace('{output}', outputNum);

        await this._hass.callService('vda_ir_control', 'send_raw_serial_command', {
          device_id: matrixId,
          payload: rawCommand,
          format: 'text',
          line_ending: 'cr',
          wait_for_response: false,
        });
      } else {
        // Pre-defined command - use standard command service
        const serviceName = matrixType === 'network' ? 'send_network_command' : 'send_serial_command';
        await this._hass.callService('vda_ir_control', serviceName, {
          device_id: matrixId,
          command_id: commandId,
        });
      }

      this._selectedMatrixInput = commandId;
      this._lastSent = `Matrix: ${commandId}`;

      // Load the source device for the new input
      await this._loadSourceDevice();

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

  _renderCompactNowPlaying() {
    const nowPlaying = this._getNowPlayingInfo();
    if (!nowPlaying) return '';

    return `
      <div class="now-playing-compact">
        ${nowPlaying.entity_picture ? `
          <img src="${nowPlaying.entity_picture}" class="now-playing-image-compact" alt="">
        ` : ''}
        <div class="now-playing-info-compact">
          <span class="now-playing-title-compact">${nowPlaying.media_title || ''}</span>
          ${nowPlaying.media_channel ? `<span class="now-playing-channel-compact">${nowPlaying.media_channel}</span>` : ''}
        </div>
      </div>
    `;
  }

  _getNowPlayingInfo() {
    // Only show now playing for HA source devices with a media_player entity
    if (!this._sourceIsHADevice || !this._sourceMediaPlayerEntity) {
      return null;
    }

    const state = this._hass.states[this._sourceMediaPlayerEntity];
    if (!state || state.state === 'off' || state.state === 'unavailable') {
      return null;
    }

    const attrs = state.attributes || {};
    // Only return if there's actual media info to display
    if (!attrs.media_title && !attrs.media_channel) {
      return null;
    }

    return {
      media_title: attrs.media_title || null,
      media_series_title: attrs.media_series_title || null,
      media_channel: attrs.media_channel || null,
      entity_picture: attrs.entity_picture || null,
      state: state.state,
    };
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
      tv: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`,
      cable_box: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 6H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H4V8h16v8zM6 10h2v4H6zm3.5 0h2v4h-2zm3.5 0h2v4h-2z"/></svg>`,
      soundbar: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
      streaming: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8l7 4-7 4V8z"/></svg>`,
      audio_receiver: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>`,
      projector: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M22 7v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2zM4 17h16V7H4v10zm10-5c0-1.66-1.34-3-3-3s-3 1.34-3 3 1.34 3 3 3 3-1.34 3-3zm5-2h2v2h-2z"/></svg>`,
    };
    return icons[this._deviceType] || icons.tv;
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
    this._deviceGroups = [];
    this._availableCommands = [];
  }

  set hass(hass) {
    this._hass = hass;
    this._loadDevices();
  }

  setConfig(config) {
    this._config = config;
    this._loadAvailableCommands();
    this._render();
  }

  async _loadDevices() {
    if (!this._hass) return;

    try {
      // Load devices
      const devicesResp = await fetch('/api/vda_ir_control/devices', {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (devicesResp.ok) {
        const data = await devicesResp.json();
        this._devices = data.devices || [];
      }

      // Load device groups
      const groupsResp = await fetch('/api/vda_ir_control/device_groups', {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (groupsResp.ok) {
        const data = await groupsResp.json();
        this._deviceGroups = data.groups || [];
      }

      // Load commands for currently selected device
      await this._loadAvailableCommands();
      this._render();
    } catch (e) {
      console.error('Failed to load devices:', e);
    }
  }

  async _loadAvailableCommands() {
    if (!this._hass || !this._config.device_id) {
      this._availableCommands = [];
      return;
    }

    // Check if it's a device group (groups don't have commands)
    const isGroup = this._deviceGroups.some(g => g.group_id === this._config.device_id);
    if (isGroup) {
      this._availableCommands = [];
      return;
    }

    // Find the device
    const device = this._devices.find(d => d.device_id === this._config.device_id);
    if (!device || !device.device_profile_id) {
      this._availableCommands = [];
      return;
    }

    try {
      // Load profile commands
      const profileId = device.device_profile_id;
      const isBuiltin = profileId.startsWith('builtin:');
      const endpoint = isBuiltin
        ? `/api/vda_ir_control/builtin_profiles/${profileId.replace('builtin:', '')}`
        : `/api/vda_ir_control/profiles/${profileId}`;

      const resp = await fetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
      });
      if (resp.ok) {
        const profile = await resp.json();
        this._availableCommands = Object.keys(profile.codes || {});
      }
    } catch (e) {
      console.error('Failed to load commands:', e);
      this._availableCommands = [];
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
        <label>Device or Group</label>
        <select id="device_id">
          <option value="">Select a device or group...</option>
          ${this._deviceGroups.length > 0 ? `
            <optgroup label="Device Groups">
              ${this._deviceGroups.map(g => `
                <option value="${g.group_id}" ${this._config.device_id === g.group_id ? 'selected' : ''}>
                  ${g.name} ${g.location ? `(${g.location})` : ''} [${g.members?.length || 0} devices]
                </option>
              `).join('')}
            </optgroup>
          ` : ''}
          ${this._devices.length > 0 ? `
            <optgroup label="Individual Devices">
              ${this._devices.map(d => `
                <option value="${d.device_id}" ${this._config.device_id === d.device_id ? 'selected' : ''}>
                  ${d.name} ${d.location ? `(${d.location})` : ''}
                </option>
              `).join('')}
            </optgroup>
          ` : ''}
        </select>
        <div class="help-text">Select a device or group to control</div>
      </div>

      <div class="form-group">
        <label>Display Name (optional)</label>
        <input type="text" id="name" value="${this._config.name || ''}" placeholder="Override device name">
        <div class="help-text">Leave empty to use device name</div>
      </div>

      ${this._config.device_id && this._devices.length > 1 ? `
        <div class="form-group">
          <label>Additional TV Power Buttons</label>
          <div class="help-text" style="margin-bottom: 8px;">Select other TVs to add power buttons for (e.g., TVs sharing an HDMI splitter)</div>
          <div style="max-height: 120px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 6px; padding: 8px;">
            ${this._devices.filter(d => d.device_id !== this._config.device_id).map(d => `
              <div style="padding: 4px 0;">
                <label style="display: block; cursor: pointer;">
                  <input type="checkbox" class="tv-device-checkbox" data-device-id="${d.device_id}"
                         ${(this._config.tv_devices || []).includes(d.device_id) ? 'checked' : ''}
                         style="margin-right: 8px; vertical-align: middle;">
                  <span style="vertical-align: middle;">${d.name}${d.location ? ` (${d.location})` : ''}</span>
                </label>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${this._availableCommands.length > 0 ? `
        <div class="form-group">
          <label>Quick Buttons</label>
          <div class="help-text" style="margin-bottom: 8px;">Select commands to show as quick access buttons</div>
          <div style="max-height: 150px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 6px; padding: 8px;">
            ${this._availableCommands.map(cmd => `
              <div style="padding: 4px 0;">
                <label style="display: block; cursor: pointer;">
                  <input type="checkbox" class="quick-btn-checkbox" data-command="${cmd}"
                         ${(this._config.quick_buttons || []).includes(cmd) ? 'checked' : ''}
                         style="margin-right: 8px; vertical-align: middle;">
                  <span style="vertical-align: middle;">${this._formatCommandName(cmd)}</span>
                </label>
              </div>
            `).join('')}
          </div>
        </div>
      ` : this._config.device_id && !this._deviceGroups.some(g => g.group_id === this._config.device_id) ? `
        <div class="form-group">
          <label>Quick Buttons</label>
          <div class="help-text">Loading available commands...</div>
        </div>
      ` : ''}
    `;

    // Event listeners
    this.shadowRoot.getElementById('device_id').addEventListener('change', async (e) => {
      this._updateConfig('device_id', e.target.value);
      await this._loadAvailableCommands();
      this._render();
    });
    this.shadowRoot.getElementById('name').addEventListener('input', (e) => {
      this._updateConfig('name', e.target.value);
    });
    this.shadowRoot.querySelectorAll('.quick-btn-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = Array.from(this.shadowRoot.querySelectorAll('.quick-btn-checkbox:checked'))
          .map(c => c.dataset.command);
        this._updateConfig('quick_buttons', checked.length > 0 ? checked : null);
      });
    });
    this.shadowRoot.querySelectorAll('.tv-device-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = Array.from(this.shadowRoot.querySelectorAll('.tv-device-checkbox:checked'))
          .map(c => c.dataset.deviceId);
        this._updateConfig('tv_devices', checked.length > 0 ? checked : null);
      });
    });
  }

  _formatCommandName(cmd) {
    return cmd.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
