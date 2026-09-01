/**
 * VDA IR Remote Card
 * A custom Lovelace card for controlling IR devices
 * @version 1.9.19
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
    // Channel tuning state
    this._tuningChannel = null;
    // Channel edit mode
    this._channelEditMode = false;
    this._editingChannels = [];
    // Global channel presets (shared across all DTV sources)
    this._globalChannelPresets = [];
    // Serial devices
    this._isSerialDevice = false;
    this._serialDevice = null;
    this._serialDevices = [];
    this._serialCommands = [];
    // Serial device state (for projectors with query_power)
    this._serialDeviceState = null; // { power: "on"|"off"|"unknown", connected: bool }
    this._statePollingInterval = null;
    this._isQueryingPower = false;
    // Serial device matrix linking
    this._serialDeviceMatrixId = null;
    this._serialDeviceMatrixPort = null;
    // Other devices sharing the same matrix output (for power buttons)
    this._serialOutputDevices = [];
    // Matrix sensor entity for cross-device sync
    this._matrixSensorEntity = null;
    // Channel number buffer
    this._channelBuffer = '';
    this._channelBufferTimeout = null;
    this._channelBufferDelay = 1500; // ms to wait before sending
    this._channelDigitDelay = 200; // ms between each digit
    // Bind the event handler so we can remove it later
    this._onFavoritesUpdated = this._onFavoritesUpdated.bind(this);
  }

  connectedCallback() {
    // Listen for favorites updates from other cards
    window.addEventListener('vda-favorites-updated', this._onFavoritesUpdated);
  }

  disconnectedCallback() {
    // Clean up event listener
    window.removeEventListener('vda-favorites-updated', this._onFavoritesUpdated);
    // Stop power state polling
    this._stopStatePolling();
  }

  _onFavoritesUpdated(event) {
    // Another card updated favorites - refresh our copy
    if (event.detail && event.detail.channels) {
      this._globalChannelPresets = event.detail.channels;
      this._render();
    }
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

    // Watch for matrix sensor state changes (cross-device sync)
    if (this._matrixSensorEntity && oldHass) {
      const oldState = oldHass.states[this._matrixSensorEntity];
      const newState = hass.states[this._matrixSensorEntity];
      if (newState && (!oldState || oldState.state !== newState.state)) {
        const newInputNum = newState.state;
        if (newInputNum && newInputNum !== 'unknown') {
          const newSelectedInput = `route_input_${newInputNum}`;
          if (this._selectedMatrixInput !== newSelectedInput) {
            console.log('[Matrix Sync] Sensor state changed:', newInputNum, '- updating UI');
            this._selectedMatrixInput = newSelectedInput;
            // Load the source device for the new input
            if (this._isSerialDevice) {
              this._loadSourceDeviceForSerial().then(() => this._render());
            } else {
              this._loadSourceDevice().then(() => this._render());
            }
          }
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
      const [groupsData, devicesData, serialData, haData, channelPresetsData] = await Promise.all([
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
        VDADataCache.fetch('channel_presets', async () => {
          const resp = await fetch('/api/vda_ir_control/channel_presets', { headers: authHeader });
          return resp.ok ? resp.json() : { channels: [] };
        }),
      ]);

      // Store global channel presets
      this._globalChannelPresets = channelPresetsData.channels || [];

      // Process groups
      const groups = groupsData.groups || [];
      this._deviceGroup = groups.find(g => g.group_id === this._config.device_id);
      this._isDeviceGroup = !!this._deviceGroup;

      // Process devices
      const allDevices = devicesData.devices || [];
      this._allDevices = allDevices;

      // Process serial devices
      const serialDevices = serialData.devices || [];
      this._serialDevices = serialDevices;

      // Check if this is a serial device (device_id starts with serial:)
      const configDeviceId = this._config.device_id || '';
      this._isSerialDevice = configDeviceId.startsWith('serial:');

      if (this._isSerialDevice) {
        const serialDeviceId = configDeviceId.replace('serial:', '');
        this._serialDevice = serialDevices.find(d => d.device_id === serialDeviceId);
        this._device = null;
      } else if (!this._isDeviceGroup) {
        this._device = allDevices.find(d => d.device_id === this._config.device_id);
        this._serialDevice = null;
      }

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

      // Load TV devices for serial device cards too
      if (this._isSerialDevice && this._config.tv_devices && Array.isArray(this._config.tv_devices)) {
        this._tvDevices = this._config.tv_devices
          .map(tvId => allDevices.find(d => d.device_id === tvId))
          .filter(d => d !== null && d !== undefined);
      }

      // Load serial device commands (need to fetch individual device for full command data)
      if (this._isSerialDevice && this._serialDevice) {
        try {
          const detailResp = await fetch(`/api/vda_ir_control/serial_devices/${encodeURIComponent(this._serialDevice.device_id)}`, {
            headers: authHeader,
          });
          if (detailResp.ok) {
            const fullDevice = await detailResp.json();
            this._serialDevice = fullDevice;
            const commands = fullDevice.commands || {};
            this._serialCommands = Object.keys(commands).map(cmdId => ({
              command_id: cmdId,
              name: commands[cmdId].name || cmdId,
              ...commands[cmdId]
            }));
            console.log('Serial device loaded:', this._serialDevice.name, 'Commands:', this._serialCommands.length, this._serialCommands.map(c => c.command_id));

            // For devices with power commands, query initial state and start polling
            const hasPowerCommands = this._serialCommands.some(c => c.command_id === 'power_on' || c.command_id === 'power_off');
            if (hasPowerCommands) {
              // Query initial state (non-blocking)
              this._queryPowerState().catch(e => console.warn('Initial power query failed:', e));
              // Start polling
              this._startStatePolling();
            }
          }

          // Check if this serial device is assigned to a matrix output
          // Need to fetch full matrix details since list API doesn't include device_id in outputs
          const matrixDevices = serialDevices.filter(d => d.device_type === 'hdmi_matrix');
          for (const matrix of matrixDevices) {
            // Fetch full matrix details to get device_id assignments
            const matrixDetailResp = await fetch(`/api/vda_ir_control/serial_devices/${encodeURIComponent(matrix.device_id)}`, {
              headers: authHeader,
            });
            if (matrixDetailResp.ok) {
              const fullMatrix = await matrixDetailResp.json();
              const outputs = fullMatrix.matrix_outputs || [];
              const outputMatch = outputs.find(o => o.device_id === this._serialDevice.device_id);
              if (outputMatch) {
                // Found! This serial device is connected to this matrix output
                this._serialDeviceMatrixId = matrix.device_id;
                this._serialDeviceMatrixPort = outputMatch.index;
                console.log('Serial device connected to matrix:', matrix.device_id, 'port:', outputMatch.index);
                // Store the full matrix and build input commands
                this._matrixDevice = fullMatrix;
                const matrixInputs = fullMatrix.matrix_inputs || [];
                this._matrixInputCommands = matrixInputs
                  .filter(input => input.enabled !== false)
                  .map(input => ({
                    command_id: `route_input_${input.index}`,
                    name: input.name || `Input ${input.index}`,
                    input_value: String(input.index),
                    device_id: input.device_id,
                    _generated: true
                  }));
                console.log('Matrix inputs loaded:', this._matrixInputCommands.length);

                // Set up sensor entity for cross-device sync
                // Entity ID format: sensor.{matrix_name}_{output_name} with spaces->underscores, lowercase
                const matrixName = (fullMatrix.name || matrix.device_id).toLowerCase().replace(/[^a-z0-9]+/g, '_');
                const outputName = (outputMatch.name || `output_${outputMatch.index}`).toLowerCase().replace(/[^a-z0-9]+/g, '_');
                this._matrixSensorEntity = `sensor.${matrixName}_${outputName}`;
                console.log('Matrix sensor entity:', this._matrixSensorEntity);

                // Find other devices sharing the same matrix output (for splitter scenarios)
                // Check IR devices (matrix_port is stored as string, outputMatch.index is number)
                const irDevicesOnOutput = allDevices.filter(d =>
                  String(d.matrix_port) === String(outputMatch.index) &&
                  d.matrix_device_id === matrix.device_id
                );
                // Check other serial devices on the same output (excluding self and matrix)
                const serialDevicesOnOutput = outputs
                  .filter(o => o.index === outputMatch.index && o.device_id && o.device_id !== this._serialDevice.device_id)
                  .map(o => serialDevices.find(sd => sd.device_id === o.device_id))
                  .filter(sd => sd && sd.device_type !== 'hdmi_matrix');
                this._serialOutputDevices = [...irDevicesOnOutput, ...serialDevicesOnOutput];
                console.log('Other devices on same output:', this._serialOutputDevices.map(d => d.name || d.device_id));

                // Query current routing (non-blocking) and re-render when done
                this._queryMatrixRoutingForSerial().then(() => {
                  if (this._selectedMatrixInput) {
                    console.log('[Matrix Query] Re-rendering after query complete');
                    this._render();
                  }
                }).catch(e => console.warn('Matrix query failed:', e));
                break;
              }
            }
          }
        } catch (e) {
          console.error('Failed to load serial device details:', e);
          this._serialCommands = [];
        }
      } else {
        this._serialCommands = [];
        if (this._isSerialDevice) {
          console.warn('Serial device flag set but device not found. Config device_id:', this._config.device_id);
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
        console.log('Matrix device loaded:', this._matrixDevice.device_id, 'type:', matrixType);

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
        console.log('Matrix input commands:', this._matrixInputCommands.length, 'inputs');

        // Set up sensor entity for cross-device sync (IR devices)
        if (deviceOutput) {
          // Find output name from matrix outputs
          const matrixOutputs = this._matrixDevice.matrix_outputs || [];
          const outputMatch = matrixOutputs.find(o => String(o.index) === String(deviceOutput));
          const matrixName = (this._matrixDevice.name || matrixId).toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const outputName = (outputMatch?.name || `output_${deviceOutput}`).toLowerCase().replace(/[^a-z0-9]+/g, '_');
          this._matrixSensorEntity = `sensor.${matrixName}_${outputName}`;
          console.log('Matrix sensor entity (IR):', this._matrixSensorEntity);
        }
      } else {
        console.warn('Matrix fetch failed:', matrixResp.status);
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

  async _loadMatrixForSerialDevice(matrixId, authHeader) {
    // Load matrix details for a serial device that's connected to a matrix output
    try {
      const matrixResp = await fetch(`/api/vda_ir_control/serial_devices/${encodeURIComponent(matrixId)}`, {
        headers: authHeader,
      });

      if (matrixResp.ok) {
        this._matrixDevice = await matrixResp.json();

        // Build input commands from matrix_inputs
        const matrixInputs = this._matrixDevice.matrix_inputs || [];
        this._matrixInputCommands = matrixInputs
          .filter(input => input.enabled !== false)
          .map(input => ({
            command_id: `route_input_${input.index}`,
            name: input.name || `Input ${input.index}`,
            input_value: String(input.index),
            device_id: input.device_id,
            _generated: true
          }));

        console.log('Matrix loaded for serial device:', this._matrixDevice.name, 'inputs:', this._matrixInputCommands.length);

        // Query current routing state (non-blocking)
        this._queryMatrixRoutingForSerial().then(() => {
          if (this._selectedMatrixInput) {
            this._render();
          }
        }).catch(e => console.warn('Matrix query for serial device failed:', e));
      }
    } catch (e) {
      console.error('Failed to load matrix for serial device:', e);
    }
  }

  async _queryMatrixRoutingForSerial() {
    // Read routing state from HA sensor (instant, no serial query needed)
    if (!this._matrixSensorEntity || !this._hass) {
      console.log('[Matrix State] No sensor entity or hass');
      return;
    }

    const sensorState = this._hass.states[this._matrixSensorEntity];
    console.log('[Matrix State] Reading sensor:', this._matrixSensorEntity, '=', sensorState?.state);

    if (sensorState && sensorState.state && sensorState.state !== 'unknown') {
      const inputNum = sensorState.state;
      this._selectedMatrixInput = `route_input_${inputNum}`;
      console.log('[Matrix State] Set selectedMatrixInput to:', this._selectedMatrixInput);
      await this._loadSourceDeviceForSerial();
    }
  }

  async _loadSourceDeviceForSerial() {
    // Load the source device for serial device's selected matrix input
    if (!this._selectedMatrixInput || !this._matrixInputCommands) {
      this._sourceDevice = null;
      this._sourceCommands = [];
      return;
    }

    const selectedCmd = this._matrixInputCommands.find(c => c.command_id === this._selectedMatrixInput);
    if (!selectedCmd || !selectedCmd.device_id) {
      this._sourceDevice = null;
      this._sourceCommands = [];
      return;
    }

    // Find source device in controlled devices, HA devices, or serial devices
    const sourceDeviceId = selectedCmd.device_id;

    // Check IR controlled devices
    let sourceDevice = this._allDevices.find(d => d.device_id === sourceDeviceId);
    if (sourceDevice) {
      this._sourceDevice = sourceDevice;
      this._sourceIsHADevice = false;
      // Load source device commands
      await this._loadSourceCommands();
      return;
    }

    // Check HA devices
    const haDevice = this._haDevices.find(d => d.device_id === sourceDeviceId);
    if (haDevice) {
      this._sourceDevice = haDevice;
      this._sourceIsHADevice = true;
      this._sourceMediaPlayerEntity = haDevice.media_player_entity_id;
      this._sourceCommands = [];
      return;
    }

    this._sourceDevice = null;
    this._sourceCommands = [];
  }

  async _queryMatrixRouting() {
    // Read routing state from HA sensor (instant, no serial query needed)
    if (!this._matrixSensorEntity || !this._hass) {
      console.log('[Matrix State] No sensor entity or hass (IR device)');
      return;
    }

    const sensorState = this._hass.states[this._matrixSensorEntity];
    console.log('[Matrix State] Reading sensor (IR):', this._matrixSensorEntity, '=', sensorState?.state);

    if (sensorState && sensorState.state && sensorState.state !== 'unknown') {
      const inputNum = sensorState.state;
      // Find the corresponding command
      const matchingCmd = this._matrixInputCommands.find(cmd =>
        cmd.input_value === inputNum || cmd.input_value === String(inputNum)
      );
      if (matchingCmd) {
        this._selectedMatrixInput = matchingCmd.command_id;
        console.log('[Matrix State] Set selectedMatrixInput to:', this._selectedMatrixInput);
        await this._loadSourceDevice();
        this._render();
      }
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
          height: 100%;
        }
        ha-card {
          overflow: visible;
          height: 100%;
          box-sizing: border-box;
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
          width: 95vw;
          max-width: 900px;
          max-height: 90vh;
          overflow-y: auto;
          overflow-x: hidden;
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
        .remote-layout-new > .now-playing-compact:first-child {
          border-top: none;
          margin-top: 0;
          padding-top: 0;
          margin-bottom: 4px;
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
          background: rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 14px;
          margin-bottom: 8px;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        /* Landscape three-column layout */
        .remote-layout {
          display: flex;
          flex-direction: column;
        }
        @media (min-width: 600px) and (min-aspect-ratio: 1/1) {
          .remote-layout {
            display: grid;
            grid-template-columns: auto 1fr auto;
            grid-template-rows: auto 1fr;
            gap: 12px;
            align-items: start;
          }
          .remote-layout .remote-header {
            grid-column: 1 / -1;
          }
          .remote-layout .remote-left {
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-width: 100px;
          }
          .remote-layout .remote-center {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .remote-layout .remote-right {
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-width: 150px;
            max-width: 250px;
          }
          .remote-layout .remote-section {
            margin-bottom: 0;
          }
          .remote-layout .channel-picker {
            max-height: 300px;
            overflow-y: auto;
          }
        }
        .section-label {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.7);
          text-transform: uppercase;
          text-align: center;
          margin-bottom: 8px;
          font-weight: 500;
          letter-spacing: 0.5px;
        }
        .btn {
          border: none;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.15);
          color: var(--primary-text-color);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
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
        /* Dynamic power button styles */
        .btn.power-dynamic {
          min-width: 120px;
          padding: 10px 16px;
          font-weight: 500;
          transition: background 0.3s ease, transform 0.1s ease;
        }
        .btn.power-dynamic.power-on {
          background: var(--success-color, #4caf50);
          color: white;
        }
        .btn.power-dynamic.power-on:hover {
          background: #43a047;
        }
        .btn.power-dynamic.power-off {
          background: var(--error-color, #f44336);
          color: white;
        }
        .btn.power-dynamic.power-off:hover {
          background: #e53935;
        }
        .btn.power-dynamic.disconnected {
          background: var(--disabled-text-color, #9e9e9e);
          color: white;
          cursor: not-allowed;
          opacity: 0.7;
        }
        .btn.power-dynamic.querying {
          background: var(--primary-color, #03a9f4);
          color: white;
          animation: pulse-power 1.5s ease-in-out infinite;
        }
        @keyframes pulse-power {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1; }
        }
        .power-control-row {
          justify-content: center;
        }
        /* Compact dynamic power button (for header row) */
        .btn.power-dynamic-compact {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 10px 16px;
          min-width: 70px;
          transition: background 0.3s ease;
        }
        .btn.power-dynamic-compact.power-on {
          background: var(--success-color, #4caf50);
          color: white;
        }
        .btn.power-dynamic-compact.power-off {
          background: var(--error-color, #f44336);
          color: white;
        }
        .btn.power-dynamic-compact.disconnected {
          background: var(--disabled-text-color, #9e9e9e);
          color: white;
          cursor: not-allowed;
          opacity: 0.7;
        }
        .btn.power-dynamic-compact.querying {
          background: var(--primary-color, #03a9f4);
          color: white;
          animation: pulse-power 1.5s ease-in-out infinite;
        }
        /* Quick dynamic power button (for card header) */
        .quick-btn.power-dynamic-quick.power-on {
          background: var(--success-color, #4caf50) !important;
          color: white;
        }
        .quick-btn.power-dynamic-quick.power-off {
          background: var(--error-color, #f44336) !important;
          color: white;
        }
        .quick-btn.power-dynamic-quick.disconnected {
          background: var(--disabled-text-color, #9e9e9e) !important;
          color: white;
          cursor: not-allowed;
          opacity: 0.7;
        }
        .quick-btn.power-dynamic-quick.querying {
          background: var(--primary-color, #03a9f4) !important;
          color: white;
          animation: pulse-power 1.5s ease-in-out infinite;
        }
        .dpad {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          width: 100%;
          max-width: 200px;
          margin: 0 auto;
        }
        .dpad .btn {
          width: 100%;
          height: 60px;
          font-size: 18px;
        }
        .dpad .btn.ok {
          background: var(--primary-color);
          color: white;
          border-radius: 50%;
          font-size: 16px;
        }
        .nav-row {
          display: flex;
          justify-content: center;
          gap: 6px;
          margin-top: 8px;
          flex-wrap: wrap;
        }
        .nav-row .btn {
          padding: 10px 14px;
          font-size: 13px;
        }
        .vol-chan {
          display: flex;
          justify-content: space-around;
        }
        .vol-group, .chan-group {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .vol-group .btn, .chan-group .btn {
          width: 56px;
          height: 48px;
          font-size: 20px;
        }
        .numpad {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          width: 100%;
        }
        .numpad .btn {
          height: 44px;
          font-size: 18px;
          font-weight: 600;
        }
        .channel-buffer-display {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: rgba(0, 0, 0, 0.85);
          color: #fff;
          font-size: 36px;
          font-weight: bold;
          padding: 16px 32px;
          border-radius: 12px;
          z-index: 9999;
          min-width: 100px;
          text-align: center;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
          opacity: 1;
          transition: opacity 0.3s ease;
        }
        .channel-buffer-display.hidden {
          opacity: 0;
          pointer-events: none;
        }
        .input-row, .playback-row {
          display: flex;
          justify-content: center;
          gap: 5px;
          flex-wrap: wrap;
        }
        .input-row .btn, .playback-row .btn {
          padding: 8px 10px;
          font-size: 12px;
        }
        .color-row {
          display: flex;
          justify-content: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .color-row .btn {
          width: 50px;
          height: 36px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          font-size: 0;
          transition: transform 0.1s, box-shadow 0.1s;
        }
        .color-row .btn:hover {
          transform: scale(1.1);
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }
        .color-row .btn.color-red {
          background: #e53935;
        }
        .color-row .btn.color-green {
          background: #43a047;
        }
        .color-row .btn.color-yellow {
          background: #fdd835;
        }
        .color-row .btn.color-blue {
          background: #1e88e5;
        }
        /* Channel picker */
        .channel-picker {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
          gap: 8px;
          margin-top: 8px;
        }
        .channel-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 10px 6px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          background: var(--secondary-background-color, rgba(255,255,255,0.05));
          cursor: pointer;
          transition: all 0.15s ease;
          min-height: 70px;
        }
        .channel-btn:hover {
          background: var(--primary-color, #03a9f4);
          transform: scale(1.05);
        }
        .channel-btn:active {
          transform: scale(0.95);
        }
        .channel-btn.tuning {
          background: var(--primary-color, #03a9f4);
          animation: pulse 0.3s ease infinite;
        }
        .channel-btn .channel-logo {
          width: 40px;
          height: 30px;
          object-fit: contain;
          margin-bottom: 4px;
        }
        .channel-btn .channel-name {
          font-size: 11px;
          font-weight: 600;
          color: var(--primary-text-color);
          text-align: center;
          line-height: 1.2;
        }
        .channel-btn .channel-number {
          font-size: 10px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }
        .channel-section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .channel-section-header .section-label {
          margin: 0;
        }
        .channel-toggle-btn {
          background: none;
          border: none;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font-size: 12px;
          padding: 4px 8px;
        }
        /* Serial device controls */
        .serial-controls-grid {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .control-row {
          display: flex;
          justify-content: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .control-row .btn {
          padding: 10px 16px;
          font-size: 12px;
          min-width: 80px;
        }
        .control-row .btn.power {
          background: var(--error-color, #db4437);
          color: white;
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
          padding: 12px 14px;
          font-size: 14px;
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
        .matrix-input-btn-small {
          padding: 8px 10px;
          font-size: 11px;
          background: rgba(255,255,255,0.15) !important;
          color: white !important;
          border: 1px solid rgba(255,255,255,0.2) !important;
          width: 100%;
        }
        .matrix-input-btn-small:hover {
          background: rgba(255,255,255,0.3) !important;
        }
        .matrix-input-btn-small.selected {
          background: var(--primary-color) !important;
          color: white !important;
          font-weight: 600;
        }
        /* New layout structure */
        .remote-layout-new {
          display: flex;
          flex-direction: column;
          gap: 8px;
          height: 100%;
        }
        .remote-header-full {
          width: 100%;
          flex-shrink: 0;
        }
        .remote-main-area {
          display: flex;
          gap: 10px;
          flex: 1;
          align-items: stretch;
        }
        .remote-col-left {
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex: 0 0 140px;
        }
        .remote-col-center {
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex: 1;
          min-width: 0;
        }
        .remote-col-right {
          flex: 0 0 170px;
        }
        .remote-col-right .remote-section {
          height: 100%;
          display: flex;
          flex-direction: column;
          padding: 10px;
        }
        .remote-col-right .channel-list-compact {
          flex: 1;
          max-height: none;
          overflow-y: auto;
        }
        .remote-col-left .remote-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 10px;
        }
        .remote-col-left .remote-section:first-child {
          flex: 0 0 auto;
        }
        .center-top-row, .center-bottom-row {
          display: flex;
          gap: 8px;
          flex: 1;
          min-height: 0;
        }
        .center-top-row > .remote-section,
        .center-bottom-row > .remote-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: stretch;
          padding: 10px;
          overflow: visible;
        }
        .center-top-row > .remote-section > *,
        .center-bottom-row > .remote-section > * {
          width: 100%;
        }
        .power-buttons-col, .input-buttons-col {
          display: flex;
          flex-direction: column;
          gap: 4px;
          width: 100%;
        }
        .power-buttons-col .btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 12px;
          font-size: 12px;
          width: 100%;
          justify-content: center;
        }
        .input-buttons-col .btn {
          padding: 8px 10px;
          font-size: 11px;
          width: 100%;
        }
        .side-controls {
          display: flex;
          flex-direction: column;
          gap: 6px;
          justify-content: center;
          align-items: stretch;
          width: 100%;
          flex: 1;
        }
        .nav-buttons-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 5px;
          width: 100%;
        }
        .nav-buttons-grid .btn {
          padding: 8px 6px;
          font-size: 11px;
        }
        /* Vol/Chan 3-wide grid */
        .vol-chan-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          width: 100%;
        }
        .vol-chan-grid .btn {
          height: 44px;
          font-size: 13px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        /* Compact channel list for right column */
        .channel-list-compact {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .channel-btn-compact {
          padding: 12px 10px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.15);
          background: rgba(255,255,255,0.08);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 12px;
          text-align: center;
          font-weight: 500;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }
        .channel-btn-compact:hover {
          background: var(--primary-color);
          color: white;
        }
        .channel-btn-compact.tuning {
          background: var(--primary-color);
          color: white;
        }
        .section-label-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .section-label-row .section-label {
          margin-bottom: 0;
        }
        .edit-channels-btn {
          background: rgba(255,255,255,0.1);
          border: none;
          border-radius: 4px;
          color: var(--primary-text-color);
          cursor: pointer;
          padding: 4px 8px;
          font-size: 12px;
        }
        .edit-channels-btn:hover {
          background: var(--primary-color);
        }
        .channel-edit-mode {
          gap: 8px !important;
        }
        .channel-edit-row {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .channel-name-input, .channel-number-input {
          flex: 1;
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 4px;
          color: var(--primary-text-color);
          padding: 6px 8px;
          font-size: 11px;
        }
        .channel-name-input {
          flex: 2;
        }
        .channel-number-input {
          width: 45px;
          flex: 0 0 45px;
          text-align: center;
        }
        .channel-delete-btn {
          background: rgba(255,0,0,0.3);
          border: none;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          padding: 6px 8px;
          font-size: 11px;
        }
        .channel-delete-btn:hover {
          background: rgba(255,0,0,0.6);
        }
        .channel-add-btn {
          background: rgba(255,255,255,0.1);
          border: 1px dashed rgba(255,255,255,0.3);
          border-radius: 6px;
          color: var(--primary-text-color);
          cursor: pointer;
          padding: 8px;
          font-size: 11px;
          width: 100%;
          margin-top: 4px;
        }
        .channel-add-btn:hover {
          background: rgba(255,255,255,0.2);
        }
        .no-channels {
          color: var(--secondary-text-color);
          font-size: 11px;
          text-align: center;
          padding: 12px;
        }
        .not-found {
          padding: 16px;
          text-align: center;
          color: var(--secondary-text-color);
          font-size: 13px;
        }
        .group-card {
          padding: 24px 16px 16px 16px;
          position: relative;
          min-height: 80px;
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
          padding: 6px 12px;
          border-radius: 6px;
          border: none;
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          transition: all 0.2s;
          margin-left: 4px;
        }
        .group-power-btn-small.on {
          background: var(--success-color, #4caf50);
          color: white;
        }
        .group-power-btn-small.off {
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
        }
        .group-power-btn-small:hover {
          transform: scale(1.05);
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
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
        .group-power-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.85);
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          z-index: 100;
          border-radius: var(--ha-card-border-radius, 12px);
        }
        .group-power-overlay .overlay-icon {
          font-size: 48px;
          margin-bottom: 16px;
          animation: pulse-overlay 1s infinite;
        }
        .group-power-overlay .overlay-text {
          font-size: 18px;
          font-weight: 600;
          color: white;
          text-align: center;
        }
        .group-power-overlay .overlay-subtext {
          font-size: 13px;
          color: rgba(255,255,255,0.7);
          margin-top: 8px;
        }
        .group-power-overlay.success {
          background: rgba(76, 175, 80, 0.95);
        }
        .group-power-overlay.success .overlay-icon {
          animation: none;
        }
        @keyframes pulse-overlay {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.1); }
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
        .quick-btn.compact.labeled {
          width: auto;
          min-width: 36px;
          padding: 0 8px;
          border-radius: 18px;
          gap: 4px;
        }
        .quick-btn.compact.labeled svg {
          width: 14px;
          height: 14px;
        }
        .quick-btn .btn-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: -0.3px;
        }
        .matrix-input-select.compact {
          padding: 6px 8px;
          font-size: 12px;
          margin-right: 6px;
          max-width: 100px;
        }

        /* Screen Remote Styles */
        .screen-remote {
          padding: 16px;
        }
        .screen-remote .remote-section {
          display: flex;
          justify-content: center;
          margin-bottom: 12px;
        }
        .screen-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 12px 24px;
          font-size: 14px;
          font-weight: 500;
          gap: 4px;
          min-width: 100px;
        }
        .screen-btn.up-btn {
          background: var(--success-color, #4caf50);
          color: white;
          padding: 16px 32px;
        }
        .screen-btn.down-btn {
          background: var(--info-color, #2196f3);
          color: white;
          padding: 16px 32px;
        }
        .screen-btn.stop-btn {
          background: var(--warning-color, #ff9800);
          color: white;
        }
        .bump-row {
          display: flex;
          gap: 12px;
        }
        .bump-btn {
          flex-direction: row;
          gap: 6px;
          padding: 10px 16px;
          background: var(--primary-color);
          color: white;
        }
      </style>

      <ha-card>
        ${this._isDeviceGroup && this._deviceGroup ? `
          <div class="group-card">
            ${this._isSendingGroupPower ? `
              <div class="group-power-overlay">
                <div class="overlay-icon">${this._isSendingGroupPower === 'on' ? '⚡' : '🌙'}</div>
                <div class="overlay-text">Turning ${this._isSendingGroupPower === 'on' ? 'ON' : 'OFF'} All TVs...</div>
                <div class="overlay-subtext">Please wait</div>
              </div>
            ` : ''}
            <div class="group-header">
              <span class="group-icon"><svg viewBox="0 0 24 24"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg></span>
              <div style="flex:1">
                <div class="group-name">${this._config.name || this._deviceGroup.name}</div>
                <div class="group-members-inline">${this._groupMemberDevices.length} device${this._groupMemberDevices.length !== 1 ? 's' : ''}</div>
              </div>
              <button class="group-power-btn-small on ${this._isSendingGroupPower === 'on' ? 'sending' : ''}" id="group-power-on-btn" title="Turn All Devices ON" ${this._isSendingGroupPower ? 'disabled' : ''}>
                ON
              </button>
              <button class="group-power-btn-small off ${this._isSendingGroupPower === 'off' ? 'sending' : ''}" id="group-power-off-btn" title="Turn All Devices OFF" ${this._isSendingGroupPower ? 'disabled' : ''}>
                OFF
              </button>
            </div>
            ${this._groupPowerStatus && !this._isSendingGroupPower ? `
              <div class="group-status">${this._groupPowerStatus}</div>
            ` : ''}
          </div>
        ` : this._isSerialDevice && this._serialDevice ? `
          <div class="card-content">
            <div class="card-header">
              <span class="device-icon">${this._getSerialDeviceIcon()}</span>
              <div style="flex:1">
                <div class="device-name">${this._config.name || this._serialDevice.name}</div>
                ${this._serialDevice.location ? `<div class="device-location">${this._serialDevice.location}</div>` : ''}
              </div>
              ${(this._serialCommands || []).some(c => c.command_id === 'power_on' || c.command_id === 'power_off')
                ? ((this._serialCommands || []).some(c => c.command_id === 'query_power')
                    ? this._renderQuickDynamicPowerButton()
                    : `${(this._serialCommands || []).some(c => c.command_id === 'power_on') ? `
                        <button class="quick-btn power compact labeled ${this._lastSent === 'power_on' ? 'sent' : ''}"
                                data-serial-command="power_on" title="Power On ${this._serialDevice.name}">
                          ${this._getCommandIcon('power')}<span class="btn-label">${this._getShortName(this._serialDevice.name)} On</span>
                        </button>` : ''}
                       ${(this._serialCommands || []).some(c => c.command_id === 'power_off') ? `
                        <button class="quick-btn power compact labeled ${this._lastSent === 'power_off' ? 'sent' : ''}"
                                data-serial-command="power_off" title="Power Off ${this._serialDevice.name}">
                          ${this._getCommandIcon('power_off')}<span class="btn-label">${this._getShortName(this._serialDevice.name)} Off</span>
                        </button>` : ''}`)
                : ''}
              ${(this._serialOutputDevices || []).map(dev => {
                const isSerial = dev.device_type && dev.device_type !== 'tv' && dev.device_type !== 'cable_box';
                const hasIRPower = dev.profile_id || (dev.commands && (dev.commands.power || dev.commands.power_on));
                const hasSerialPower = dev.commands && (dev.commands.power_on || dev.commands.power_off);
                if (!hasIRPower && !hasSerialPower) return '';
                return `
                <button class="quick-btn power compact labeled ${this._lastSent === 'power_output_' + dev.device_id ? 'sent' : ''}"
                        data-output-device-id="${dev.device_id}" data-output-device-type="${isSerial ? 'serial' : 'ir'}"
                        title="Power ${dev.name || dev.device_id}">
                  ${this._getCommandIcon('power')}<span class="btn-label">${this._getShortName(dev.name || dev.device_id)}</span>
                </button>`;
              }).join('')}
              ${(this._tvDevices || []).map(tv => `
                <button class="quick-btn power compact labeled ${this._lastSent === 'power_tv_' + tv.device_id ? 'sent' : ''}"
                        data-command="power" data-tv-device-id="${tv.device_id}" title="Power ${tv.name}">
                  ${this._getCommandIcon('power')}<span class="btn-label">${this._getShortName(tv.name)}</span>
                </button>
              `).join('')}
              ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
                <select class="matrix-input-select compact" id="serial-matrix-input-dropdown">
                  <option value="" disabled ${!this._selectedMatrixInput ? 'selected' : ''}>Input</option>
                  ${this._matrixInputCommands.map(cmd => `
                    <option value="${cmd.command_id}" ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}>
                      ${cmd.name}
                    </option>
                  `).join('')}
                </select>
              ` : ''}
              <button class="expand-btn" id="open-serial-remote">Remote</button>
            </div>
            ${this._renderCompactNowPlaying()}

            ${this._showRemote ? `
              <div class="modal-overlay" id="modal-overlay">
                <div class="modal" onclick="event.stopPropagation()">
                  <div class="modal-header">
                    <span class="modal-title">${this._sourceDevice ? `${this._config.name || this._serialDevice.name} → ${this._sourceDevice.name}` : (this._config.name || this._serialDevice.name)}</span>
                    <button class="close-btn" id="close-modal">✕</button>
                  </div>

                  <div class="toast-container">
                    <div class="sent-toast ${this._lastSent ? 'visible' : ''}">
                      <div class="toast-fill"></div>
                      <span class="toast-text">${this._lastSent ? this._formatCommand(this._lastSent) : ''}</span>
                    </div>
                  </div>

                  <div class="remote-body">
                    ${(this._serialCommands || []).some(c => c.command_id === 'power_on' || c.command_id === 'power_off') || (this._tvDevices && this._tvDevices.length > 0) ? `
                      <div class="remote-section">
                        <div class="power-row dual-power">
                          ${(this._serialCommands || []).some(c => c.command_id === 'power_on') ? `
                            ${(this._serialCommands || []).some(c => c.command_id === 'query_power')
                              ? this._renderDynamicPowerButtonCompact()
                              : `<button class="btn power ${this._lastSent === 'power_on' ? 'sent' : ''}"
                                      data-serial-command="power_on">
                                <span class="power-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg></span>
                                <span class="power-label">${this._getShortName(this._serialDevice.name)}</span>
                              </button>`
                            }
                          ` : ''}
                          ${(this._tvDevices || []).map(tv => `
                            <button class="btn power tv-power ${this._lastSent === 'power_tv_' + tv.device_id ? 'sent' : ''}"
                                    data-command="power" data-tv-device-id="${tv.device_id}">
                              <span class="power-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg></span>
                              <span class="power-label">${this._getShortName(tv.name)}</span>
                            </button>
                          `).join('')}
                        </div>
                      </div>
                    ` : ''}

                    ${this._renderCompactNowPlaying()}
                    ${this._sourceDevice && !this._sourceIsHADevice ? this._renderSourceRemoteContent() : ''}
                    ${this._sourceDevice && this._sourceIsHADevice ? this._renderHADeviceRemote() : ''}

                    ${!this._sourceDevice && this._matrixDevice ? `
                      <div class="remote-section">
                        <div class="section-label">Select Source</div>
                        <p style="color: var(--secondary-text-color); font-size: 12px; text-align: center;">
                          Select an input to show source controls
                        </p>
                      </div>
                    ` : ''}

                    ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
                      <div class="remote-section matrix-input-section">
                        <div class="section-label">Matrix Input</div>
                        <div class="matrix-input-row">
                          ${this._matrixInputCommands.map(cmd => `
                            <button class="btn matrix-input-btn ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}"
                                    data-serial-matrix-input="${cmd.command_id}" data-input-value="${cmd.input_value}">
                              ${cmd.name}
                            </button>
                          `).join('')}
                        </div>
                      </div>
                    ` : ''}

                    <!-- Projector/Serial Device Controls -->
                    ${(this._serialCommands || []).length > 0 ? `
                      <div class="remote-section">
                        <div class="section-label">${this._serialDevice.name} Controls</div>
                        <div class="serial-controls-grid">
                          ${(this._serialCommands || []).filter(c => c.command_id === 'power_on' || c.command_id === 'power_off').length > 0 ? `
                            <div class="control-row power-control-row">
                              ${(this._serialCommands || []).some(c => c.command_id === 'query_power')
                                ? this._renderDynamicPowerButton()
                                : `<button class="btn power ${this._lastSent === 'power_on' ? 'sent' : ''}"
                                          data-serial-command="power_on">⏻ Power On</button>
                                   <button class="btn ${this._lastSent === 'power_off' ? 'sent' : ''}"
                                          data-serial-command="power_off">⏻ Power Off</button>`
                              }
                            </div>
                          ` : ''}
                          ${(this._serialCommands || []).filter(c => c.is_input_option).length > 0 ? `
                            <div class="control-row">
                              ${(this._serialCommands || []).filter(c => c.is_input_option).map(cmd => `
                                <button class="btn ${this._lastSent === cmd.command_id ? 'sent' : ''}"
                                        data-serial-command="${cmd.command_id}">${cmd.name}</button>
                              `).join('')}
                            </div>
                          ` : ''}
                          ${(this._serialCommands || []).filter(c => !c.command_id.startsWith('power_') && !c.is_input_option && !c.is_query).length > 0 ? `
                            <div class="control-row">
                              ${(this._serialCommands || []).filter(c => !c.command_id.startsWith('power_') && !c.is_input_option && !c.is_query).map(cmd => `
                                <button class="btn ${this._lastSent === cmd.command_id ? 'sent' : ''}"
                                        data-serial-command="${cmd.command_id}">${cmd.name}</button>
                              `).join('')}
                            </div>
                          ` : ''}
                        </div>
                      </div>
                    ` : ''}
                  </div>
                </div>
              </div>
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
              ${this._matrixDevice ? `
                ${this._commands.includes('power') ? `
                  <button class="quick-btn power compact labeled ${this._lastSent === 'power_' + this._device.device_id ? 'sent' : ''}"
                          data-command="power" data-device-id="${this._device.device_id}" title="Power ${this._device.name}">
                    ${this._getCommandIcon('power')}<span class="btn-label">${this._getShortName(this._device.name)}</span>
                  </button>
                ` : ''}
                ${this._tvDevices.map(tv => `
                  <button class="quick-btn power compact labeled ${this._lastSent === 'power_tv_' + tv.device_id ? 'sent' : ''}"
                          data-command="power" data-tv-device-id="${tv.device_id}" title="Power ${tv.name}">
                    ${this._getCommandIcon('power')}<span class="btn-label">${this._getShortName(tv.name)}</span>
                  </button>
                `).join('')}
                ${this._matrixInputCommands.length > 0 ? `
                  <select class="matrix-input-select compact" id="matrix-input-dropdown">
                    <option value="" disabled ${!this._selectedMatrixInput ? 'selected' : ''}>Input</option>
                    ${this._matrixInputCommands.map(cmd => `
                      <option value="${cmd.command_id}" ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}>
                        ${this._getMatrixInputDisplayName(cmd)}
                      </option>
                    `).join('')}
                  </select>
                ` : ''}` : `
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
      this.shadowRoot.getElementById('group-power-on-btn')?.addEventListener('click', () => {
        this._sendGroupPowerCommand('on');
      });
      this.shadowRoot.getElementById('group-power-off-btn')?.addEventListener('click', () => {
        this._sendGroupPowerCommand('off');
      });
    }

    // Add event listeners for serial devices
    if (this._isSerialDevice && this._serialDevice) {
      this.shadowRoot.getElementById('open-serial-remote')?.addEventListener('click', async () => {
        // Load source device if matrix is connected
        if (this._matrixDevice && this._selectedMatrixInput) {
          await this._loadSourceDeviceForSerial();
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
      // Serial command buttons
      this.shadowRoot.querySelectorAll('[data-serial-command]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const commandId = btn.dataset.serialCommand;
          await this._sendSerialCommand(commandId);
        });
      });
      // Dynamic power buttons (for projectors with state feedback)
      this.shadowRoot.querySelectorAll('[data-serial-power]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const commandId = btn.dataset.serialPower;
          await this._sendSerialPowerCommand(commandId);
        });
      });
      // Compact matrix input dropdown (serial devices)
      this.shadowRoot.getElementById('serial-matrix-input-dropdown')?.addEventListener('change', async (e) => {
        const commandId = e.target.value;
        if (commandId) {
          await this._sendSerialMatrixInput(commandId);
        }
      });
      // Compact matrix input dropdown (IR devices linked to matrix)
      this.shadowRoot.getElementById('matrix-input-dropdown')?.addEventListener('change', async (e) => {
        const commandId = e.target.value;
        if (commandId) {
          await this._sendMatrixCommand(commandId);
        }
      });
      // Modal matrix input buttons
      this.shadowRoot.querySelectorAll('[data-serial-matrix-input]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const commandId = btn.dataset.serialMatrixInput;
          await this._sendSerialMatrixInput(commandId);
        });
      });
      // Source device command buttons (for IR source devices)
      this.shadowRoot.querySelectorAll('[data-source-command]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const command = btn.dataset.sourceCommand;
          if (this._sourceDevice && !this._sourceIsHADevice) {
            await this._sendCommandToDevice(command, this._sourceDevice.device_id);
          }
        });
      });
      // HA remote command buttons (for DirecTV, Apple TV, etc.)
      this.shadowRoot.querySelectorAll('[data-ha-remote]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const command = btn.dataset.haRemote;
          if (this._sourceDevice && this._sourceIsHADevice && this._sourceDevice.entity_id) {
            await this._sendHARemoteCommand(command);
          }
        });
      });
      // Output device power buttons (other devices on same matrix output)
      this.shadowRoot.querySelectorAll('[data-output-device-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const deviceId = btn.dataset.outputDeviceId;
          const deviceType = btn.dataset.outputDeviceType;
          this._lastSent = 'power_output_' + deviceId;
          this._render();
          try {
            if (deviceType === 'serial') {
              // Send power_on command to serial device
              await this._hass.callService('vda_ir_control', 'send_serial_command', {
                device_id: deviceId,
                command_id: 'power_on',
              });
            } else {
              // Send power command to IR device
              await this._hass.callService('vda_ir_control', 'send_command', {
                device_id: deviceId,
                command: 'power',
              });
            }
          } catch (e) {
            console.error('Failed to send power command:', e);
          }
          setTimeout(() => { this._lastSent = null; this._render(); }, 1000);
        });
      });
      // TV device power buttons (from tv_devices config)
      this.shadowRoot.querySelectorAll('[data-tv-device-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tvDeviceId = btn.dataset.tvDeviceId;
          this._lastSent = 'power_tv_' + tvDeviceId;
          this._render();
          try {
            await this._hass.callService('vda_ir_control', 'send_command', {
              device_id: tvDeviceId,
              command: 'power',
            });
          } catch (e) {
            console.error('Failed to send TV power command:', e);
          }
          setTimeout(() => { this._lastSent = null; this._render(); }, 1000);
        });
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

            // Check if this is a digit command (0-9) - buffer it
            if (/^[0-9]$/.test(command) && !tvDeviceId && !targetDeviceId) {
              // Determine target device for buffered digits
              let bufferTarget = null;
              if (isSource && this._sourceDevice) {
                bufferTarget = this._sourceDevice.device_id;
              } else if (this._sourceDevice && !['volume_up', 'volume_down', 'mute'].includes(command)) {
                bufferTarget = this._sourceDevice.device_id;
              }
              this._bufferChannelDigit(command, bufferTarget);
              return;
            }

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

      // Screen action buttons (bump up/down, timed down)
      this.shadowRoot.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._handleScreenAction(btn.dataset.action);
        });
      });

      // Channel picker buttons
      this.shadowRoot.querySelectorAll('[data-channel]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const channelNum = btn.dataset.channel;
          this._tuneToChannel(channelNum);
        });
      });

      // Channel edit mode handlers
      this.shadowRoot.getElementById('edit-channels-btn')?.addEventListener('click', () => {
        this._toggleChannelEditMode();
      });

      this.shadowRoot.getElementById('add-channel-btn')?.addEventListener('click', () => {
        this._addChannel();
      });

      this.shadowRoot.querySelectorAll('.channel-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.idx, 10);
          this._deleteChannel(idx);
        });
      });

      this.shadowRoot.querySelectorAll('.channel-name-input, .channel-number-input').forEach(input => {
        input.addEventListener('input', (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          const field = e.target.classList.contains('channel-name-input') ? 'name' : 'number';
          this._updateChannelField(idx, field, e.target.value);
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
    // Check if this is a projector screen device
    const profileId = this._device?.device_profile_id?.toLowerCase() || '';
    const isScreenDevice = profileId.includes('screen') || profileId.includes('elite');

    if (isScreenDevice && this._commands.includes('up') && this._commands.includes('down') && this._commands.includes('stop')) {
      return this._renderScreenRemote();
    }

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
    const colorCmds = commands.filter(c => ['red', 'green', 'yellow', 'blue'].includes(c));

    // Get channels: global presets first (shared across all DTV sources)
    const channels = (this._globalChannelPresets?.length > 0)
      ? this._globalChannelPresets
      : (this._config.channels || []);

    // Only show favorites when source is an HA device (DTV box, etc.)
    const showChannels = this._sourceIsHADevice;

    return `
      <div class="remote-layout-new">
        ${this._renderCompactNowPlaying()}
        <!-- Main content area -->
        <div class="remote-main-area">
          <!-- LEFT: Power + Inputs stacked -->
          <div class="remote-col-left">
            ${hasSourceDevice ? `
              <div class="remote-section">
                <div class="section-label">Power</div>
                <div class="power-buttons-col">
                  <button class="btn power tv-power" data-command="power" data-device-id="${this._device.device_id}">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
                    <span>${this._device.name.substring(0, 8)}</span>
                  </button>
                  ${this._tvDevices.map(tv => `
                    <button class="btn power tv-power" data-command="power" data-tv-device-id="${tv.device_id}">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
                      <span>${tv.name.substring(0, 8)}</span>
                    </button>
                  `).join('')}
                  ${powerCmds.includes('power') ? `
                    <button class="btn power source-power" data-command="power" data-source="true">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>
                      <span>${this._sourceDevice.name.substring(0, 8)}</span>
                    </button>
                  ` : ''}
                </div>
              </div>
            ` : powerCmds.length > 0 ? `
              <div class="remote-section">
                <div class="section-label">Power</div>
                <div class="power-buttons-col">
                  ${powerCmds.map(cmd => `
                    <button class="btn power" data-command="${cmd}">
                      ${cmd === 'power' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>' : this._formatCommand(cmd)}
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <!-- Inputs -->
            ${this._matrixDevice && this._matrixInputCommands.length > 0 ? `
              <div class="remote-section">
                <div class="section-label">Inputs</div>
                <div class="input-buttons-col">
                  ${this._matrixInputCommands.map(cmd => `
                    <button class="btn matrix-input-btn-small ${this._selectedMatrixInput === cmd.command_id ? 'selected' : ''}"
                            data-matrix-command="${cmd.command_id}">
                      ${this._getMatrixInputDisplayName(cmd)}
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : inputCmds.length > 0 ? `
              <div class="remote-section">
                <div class="section-label">Inputs</div>
                <div class="input-buttons-col">
                  ${inputCmds.map(cmd => `
                    <button class="btn" data-command="${cmd}">${this._formatCommand(cmd)}</button>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>

          <!-- CENTER: 2x2 grid of controls -->
          <div class="remote-col-center">
            <!-- Top row: Menu/Colors/Playback | D-pad -->
            <div class="center-top-row">
              <!-- Menu/Colors/Playback stacked -->
              <div class="remote-section side-controls">
                ${navCmds.filter(c => !['up','down','left','right','select','enter','center'].includes(c)).length > 0 ? `
                  <div class="nav-buttons-grid">
                    ${navCmds.filter(c => !['up','down','left','right','select','enter','center'].includes(c)).map(cmd => `
                      <button class="btn" data-command="${cmd}">${this._formatCommand(cmd)}</button>
                    `).join('')}
                  </div>
                ` : ''}
                ${colorCmds.length > 0 ? `
                  <div class="color-row">
                    ${colorCmds.includes('red') ? `<button class="btn color-red" data-command="red"></button>` : ''}
                    ${colorCmds.includes('green') ? `<button class="btn color-green" data-command="green"></button>` : ''}
                    ${colorCmds.includes('yellow') ? `<button class="btn color-yellow" data-command="yellow"></button>` : ''}
                    ${colorCmds.includes('blue') ? `<button class="btn color-blue" data-command="blue"></button>` : ''}
                  </div>
                ` : ''}
                ${playCmds.length > 0 ? `
                  <div class="playback-row">
                    ${playCmds.some(c => ['rewind', 'rew', 'previous', 'replay'].includes(c)) ? `<button class="btn" data-command="${playCmds.find(c => ['rewind', 'rew', 'previous', 'replay'].includes(c))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>` : ''}
                    ${playCmds.includes('play') || playCmds.includes('play_pause') ? `<button class="btn" data-command="${playCmds.includes('play') ? 'play' : 'play_pause'}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>` : ''}
                    ${playCmds.includes('pause') ? `<button class="btn" data-command="pause"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button>` : ''}
                    ${playCmds.includes('stop') ? `<button class="btn" data-command="stop"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h12v12H6z"/></svg></button>` : ''}
                    ${playCmds.some(c => ['fast_forward', 'ffwd', 'next', 'advance'].includes(c)) ? `<button class="btn" data-command="${playCmds.find(c => ['fast_forward', 'ffwd', 'next', 'advance'].includes(c))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg></button>` : ''}
                  </div>
                ` : ''}
              </div>

              <!-- D-Pad -->
              ${navCmds.length > 0 ? `
                <div class="remote-section">
                  <div class="dpad">
                    <div></div>
                    ${navCmds.includes('up') ? `<button class="btn" data-command="up"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>` : '<div></div>'}
                    <div></div>
                    ${navCmds.includes('left') ? `<button class="btn" data-command="left"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>` : '<div></div>'}
                    ${navCmds.includes('select') || navCmds.includes('enter') || navCmds.includes('center') ? `<button class="btn ok" data-command="${navCmds.includes('select') ? 'select' : navCmds.includes('center') ? 'center' : 'enter'}">OK</button>` : '<div></div>'}
                    ${navCmds.includes('right') ? `<button class="btn" data-command="right"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>` : '<div></div>'}
                    <div></div>
                    ${navCmds.includes('down') ? `<button class="btn" data-command="down"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>` : '<div></div>'}
                    <div></div>
                  </div>
                </div>
              ` : ''}
            </div>

            <!-- Bottom row: Vol/Chan | Numpad -->
            <div class="center-bottom-row">
              <!-- Vol/Chan -->
              ${volCmds.length > 0 || chanCmds.length > 0 ? `
                <div class="remote-section">
                  <div class="vol-chan-grid">
                    ${volCmds.includes('volume_up') ? `<button class="btn" data-command="volume_up"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>` : '<div></div>'}
                    ${volCmds.includes('mute') ? `<button class="btn" data-command="mute"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg></button>` : '<div></div>'}
                    ${chanCmds.some(c => c === 'channel_up' || c === 'chanup') ? `<button class="btn" data-command="${chanCmds.find(c => c === 'channel_up' || c === 'chanup')}">CH <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>` : '<div></div>'}
                    ${volCmds.includes('volume_down') ? `<button class="btn" data-command="volume_down"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg></button>` : '<div></div>'}
                    <div></div>
                    ${chanCmds.some(c => c === 'channel_down' || c === 'chandown') ? `<button class="btn" data-command="${chanCmds.find(c => c === 'channel_down' || c === 'chandown')}">CH <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>` : '<div></div>'}
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
            </div>
          </div>

          <!-- RIGHT: Favorites (only show for HA source devices like DTV) -->
          <div class="remote-col-right">
            ${showChannels || this._channelEditMode ? `
              <div class="remote-section">
                <div class="section-label-row">
                  <span class="section-label">Favorites</span>
                  <button class="edit-channels-btn" id="edit-channels-btn">
                    ${this._channelEditMode ? '✓' : '✎'}
                  </button>
                </div>
                ${this._channelEditMode ? `
                  <div class="channel-list-compact channel-edit-mode">
                    ${(this._editingChannels.length > 0 ? this._editingChannels : channels).map((ch, idx) => `
                      <div class="channel-edit-row">
                        <input type="text" class="channel-name-input" data-idx="${idx}" value="${ch.name}" placeholder="Name">
                        <input type="text" class="channel-number-input" data-idx="${idx}" value="${ch.number}" placeholder="#">
                        <button class="channel-delete-btn" data-idx="${idx}">✕</button>
                      </div>
                    `).join('')}
                    <button class="channel-add-btn" id="add-channel-btn">+ Add</button>
                  </div>
                ` : `
                  <div class="channel-list-compact">
                    ${channels.length > 0 ? channels.map(ch => `
                      <button class="channel-btn-compact ${this._tuningChannel === ch.number ? 'tuning' : ''}"
                              data-channel="${ch.number}"
                              title="${ch.name} (${ch.number})">
                        <span class="channel-name">${ch.name}</span>
                      </button>
                    `).join('') : '<div class="no-channels">No favorites yet</div>'}
                  </div>
                `}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  _renderScreenRemote() {
    return `
      <div class="screen-remote">
        <!-- Up Button -->
        <div class="remote-section">
          <button class="btn screen-btn up-btn" data-command="up">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
            <span>Up</span>
          </button>
        </div>

        <!-- Bump buttons row -->
        <div class="remote-section">
          <div class="bump-row">
            <button class="btn screen-btn bump-btn" data-action="bump-up">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
              Bump Up
            </button>
            <button class="btn screen-btn bump-btn" data-action="bump-down">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              Bump Down
            </button>
          </div>
        </div>

        <!-- Down Button (uses configured delay) -->
        <div class="remote-section">
          <button class="btn screen-btn down-btn" data-action="timed-down">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
            <span>Down</span>
          </button>
        </div>

        <!-- Stop Button -->
        <div class="remote-section">
          <button class="btn screen-btn stop-btn" data-command="stop">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
            Stop
          </button>
        </div>
      </div>
    `;
  }

  async _handleScreenAction(action) {
    const deviceId = this._device?.device_id;
    if (!deviceId) return;

    if (action === 'bump-up') {
      // Send up, then stop after 80ms
      await this._sendCommand('up');
      setTimeout(() => this._sendCommand('stop'), 80);
    } else if (action === 'bump-down') {
      // Send down, then stop after 80ms
      await this._sendCommand('down');
      setTimeout(() => this._sendCommand('stop'), 80);
    } else if (action === 'timed-down') {
      // Use the configured delay from device settings
      const delay = this._device?.screen_down_delay || 0;

      await this._sendCommand('down');
      if (delay > 0) {
        setTimeout(() => this._sendCommand('stop'), delay * 1000);
      }
    }
  }

  // Channel buffer methods
  _bufferChannelDigit(digit, targetDeviceId = null) {
    // Add digit to buffer
    this._channelBuffer = (this._channelBuffer || '') + digit;
    this._channelBufferTarget = targetDeviceId;

    // Update visual display
    this._updateChannelDisplay();

    // Clear existing timeout
    if (this._channelBufferTimeout) {
      clearTimeout(this._channelBufferTimeout);
    }

    // Set new timeout to send after delay (resets each time a digit is pressed)
    this._channelBufferTimeout = setTimeout(() => {
      this._sendBufferedChannel();
    }, this._channelBufferDelay || 1500);
  }

  async _sendBufferedChannel() {
    const digits = this._channelBuffer;
    const targetDeviceId = this._channelBufferTarget;
    this._channelBuffer = '';
    this._channelBufferTarget = null;
    this._hideChannelDisplay();

    if (!digits) return;

    // Send each digit with delay
    for (let i = 0; i < digits.length; i++) {
      if (targetDeviceId) {
        await this._sendCommandToDevice(digits[i], targetDeviceId);
      } else {
        await this._sendCommand(digits[i]);
      }
      if (i < digits.length - 1) {
        await new Promise(r => setTimeout(r, this._channelDigitDelay || 200));
      }
    }
  }

  _updateChannelDisplay() {
    // Create or update the channel display overlay
    let display = document.getElementById('vda-channel-buffer-display');
    if (!display) {
      display = document.createElement('div');
      display.id = 'vda-channel-buffer-display';
      display.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        font-size: 42px;
        font-weight: bold;
        padding: 20px 40px;
        border-radius: 16px;
        z-index: 99999;
        min-width: 120px;
        text-align: center;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        transition: opacity 0.3s ease;
      `;
      document.body.appendChild(display);
    }
    display.textContent = this._channelBuffer;
    display.style.opacity = '1';
  }

  _hideChannelDisplay() {
    const display = document.getElementById('vda-channel-buffer-display');
    if (display) {
      display.style.opacity = '0';
      // Remove after fade animation
      setTimeout(() => {
        if (display && display.style.opacity === '0') {
          display.remove();
        }
      }, 300);
    }
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

  _getChannelLogoUrl(logo) {
    if (!logo) return null;
    // Full URL - use as-is
    if (logo.startsWith('http://') || logo.startsWith('https://')) {
      return logo;
    }
    // Local path - use as-is
    if (logo.startsWith('/')) {
      return logo;
    }
    // Shorthand - use local VDA IR Control logo endpoint
    // e.g., "espn" → "/api/vda_ir_control/logos/espn"
    const cleanName = logo.toLowerCase().replace(/\s+/g, '-');
    return `/api/vda_ir_control/logos/${cleanName}`;
  }

  async _tuneToChannel(channelNum) {
    if (!this._device && !this._sourceDevice) return;

    const digits = String(channelNum).split('');

    // Check if source device is an HA device (DirecTV, etc.)
    const isHADevice = this._sourceIsHADevice && this._sourceDevice?.entity_id;
    const entityId = this._sourceDevice?.entity_id;
    const targetDeviceId = this._sourceDevice?.device_id || this._device?.device_id;

    if (!isHADevice && !targetDeviceId) return;

    this._tuningChannel = channelNum;
    this._render();

    try {
      // Send each digit with a small delay
      for (let i = 0; i < digits.length; i++) {
        const digit = digits[i];

        if (isHADevice) {
          // Use HA remote service for DirecTV, etc.
          await this._hass.callService('remote', 'send_command', {
            entity_id: entityId,
            command: digit,
          });
        } else {
          // Use VDA IR Control service for IR devices
          await this._hass.callService('vda_ir_control', 'send_command', {
            device_id: targetDeviceId,
            command: digit,
          });
        }

        // Small delay between digits
        if (i < digits.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      // Send enter/select after digits
      await new Promise(resolve => setTimeout(resolve, 150));

      if (isHADevice) {
        await this._hass.callService('remote', 'send_command', {
          entity_id: entityId,
          command: 'enter',
        });
      } else {
        await this._hass.callService('vda_ir_control', 'send_command', {
          device_id: targetDeviceId,
          command: 'enter',
        });
      }

      // Show success briefly
      setTimeout(() => {
        this._tuningChannel = null;
        this._render();
      }, 500);
    } catch (e) {
      console.error('Failed to tune to channel:', e);
      this._tuningChannel = null;
      this._render();
    }
  }

  async _toggleChannelEditMode() {
    if (this._channelEditMode) {
      // Exiting edit mode - save channels and wait for completion
      await this._saveChannels();
      this._channelEditMode = false;
    } else {
      // Entering edit mode - copy current global presets
      const channels = this._globalChannelPresets || [];
      this._editingChannels = channels.map(ch => ({ ...ch }));
      this._channelEditMode = true;
    }
    this._render();
  }

  _addChannel() {
    this._editingChannels.push({ name: '', number: '' });
    this._render();
  }

  _deleteChannel(idx) {
    this._editingChannels.splice(idx, 1);
    this._render();
  }

  _updateChannelField(idx, field, value) {
    if (this._editingChannels[idx]) {
      this._editingChannels[idx][field] = value;
    }
  }

  async _saveChannels() {
    // Filter out empty channels
    const channels = this._editingChannels.filter(ch => ch.name && ch.number);

    try {
      // Save to global channel presets (shared across ALL DTV sources)
      const response = await fetch('/api/vda_ir_control/channel_presets', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
        },
        body: JSON.stringify({ channels }),
      });

      if (response.ok) {
        // Update local data
        this._globalChannelPresets = channels;
        this._editingChannels = [];
        // Clear cache so other cards refresh when they next load
        VDADataCache.clear('channel_presets');
        // Notify other cards that favorites were updated
        window.dispatchEvent(new CustomEvent('vda-favorites-updated', { detail: { channels } }));
        // Re-render to show the updated favorites
        this._render();
      } else {
        console.error('Failed to save channels:', await response.text());
      }
    } catch (e) {
      console.error('Failed to save channels:', e);
    }
  }

  async _sendSerialCommand(commandId) {
    if (!this._serialDevice) return;

    // Debounce - prevent rapid fire commands
    const now = Date.now();
    if (this._lastSendTime && now - this._lastSendTime < 150) {
      return;
    }
    this._lastSendTime = now;

    try {
      await this._hass.callService('vda_ir_control', 'send_serial_command', {
        device_id: this._serialDevice.device_id,
        command_id: commandId,
      });

      this._lastSent = commandId;
      this._render();

      // Clear indicator after 1s
      setTimeout(() => {
        if (this._lastSent === commandId) {
          this._lastSent = null;
          this._render();
        }
      }, 1000);
    } catch (e) {
      console.error('Failed to send serial command:', e);
    }
  }

  // Serial device power state methods (for projectors)
  async _fetchSerialDeviceState() {
    if (!this._serialDevice) return null;
    try {
      const resp = await fetch(`/api/vda_ir_control/serial_devices/${encodeURIComponent(this._serialDevice.device_id)}/state`, {
        headers: { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        return {
          power: data.state?.power || 'unknown',
          connected: data.connected !== false,
        };
      }
    } catch (e) {
      console.error('Failed to fetch serial device state:', e);
    }
    return { power: 'unknown', connected: false };
  }

  async _queryPowerState() {
    if (!this._serialDevice || this._isQueryingPower) return;
    // Only query if device has query_power command
    const hasQueryPower = (this._serialCommands || []).some(c => c.command_id === 'query_power');
    if (!hasQueryPower) return;

    this._isQueryingPower = true;
    try {
      // Send query_power command to get fresh state from device
      await this._hass.callService('vda_ir_control', 'send_serial_command', {
        device_id: this._serialDevice.device_id,
        command_id: 'query_power',
      });
      // Wait a moment for device to respond
      await new Promise(r => setTimeout(r, 500));
      // Fetch the updated state
      this._serialDeviceState = await this._fetchSerialDeviceState();
      this._render();
    } catch (e) {
      console.error('Failed to query power state:', e);
    } finally {
      this._isQueryingPower = false;
    }
  }

  _startStatePolling() {
    // Only poll for serial devices with power commands
    if (!this._isSerialDevice || !this._serialDevice) return;
    const hasPowerCommands = (this._serialCommands || []).some(c =>
      c.command_id === 'power_on' || c.command_id === 'power_off'
    );
    if (!hasPowerCommands) return;

    // Stop any existing polling
    this._stopStatePolling();
    // Poll every 5 seconds
    this._statePollingInterval = setInterval(() => {
      this._queryPowerState();
    }, 5000);
    console.log('[PowerState] Started polling for', this._serialDevice.name);
  }

  _stopStatePolling() {
    if (this._statePollingInterval) {
      clearInterval(this._statePollingInterval);
      this._statePollingInterval = null;
      console.log('[PowerState] Stopped polling');
    }
  }

  async _sendSerialPowerCommand(commandId) {
    if (!this._serialDevice) return;
    try {
      await this._hass.callService('vda_ir_control', 'send_serial_command', {
        device_id: this._serialDevice.device_id,
        command_id: commandId,
      });
      this._lastSent = commandId;
      this._render();
      // Query state after sending power command (wait for device to change state)
      setTimeout(async () => {
        await this._queryPowerState();
        if (this._lastSent === commandId) {
          this._lastSent = null;
          this._render();
        }
      }, 2000);
    } catch (e) {
      console.error('Failed to send serial power command:', e);
    }
  }

  _renderDynamicPowerButton() {
    if (!this._serialDeviceState) {
      return `<button class="btn power-dynamic querying" disabled>⏻ Checking...</button>`;
    }
    const { power, connected } = this._serialDeviceState;
    if (!connected) {
      return `<button class="btn power-dynamic disconnected" disabled>⏻ Disconnected</button>`;
    }
    if (power === 'on') {
      return `<button class="btn power-dynamic power-off ${this._lastSent === 'power_off' ? 'sent' : ''}"
                      data-serial-power="power_off">⏻ Power Off</button>`;
    } else if (power === 'off') {
      return `<button class="btn power-dynamic power-on ${this._lastSent === 'power_on' ? 'sent' : ''}"
                      data-serial-power="power_on">⏻ Power On</button>`;
    } else {
      // Unknown state - show both buttons
      return `
        <button class="btn power-dynamic power-on ${this._lastSent === 'power_on' ? 'sent' : ''}"
                data-serial-power="power_on">⏻ Power On</button>
        <button class="btn power-dynamic power-off ${this._lastSent === 'power_off' ? 'sent' : ''}"
                data-serial-power="power_off">⏻ Power Off</button>
      `;
    }
  }

  _renderQuickDynamicPowerButton() {
    const deviceLabel = this._getShortName(this._serialDevice.name);
    if (!this._serialDeviceState) {
      return `<button class="quick-btn power-dynamic-quick compact labeled querying" disabled title="Checking ${this._serialDevice.name}...">
                ${this._getCommandIcon('power')}<span class="btn-label">${deviceLabel}</span>
              </button>`;
    }
    const { power, connected } = this._serialDeviceState;
    if (!connected) {
      return `<button class="quick-btn power-dynamic-quick compact labeled disconnected" disabled title="${this._serialDevice.name} disconnected">
                ${this._getCommandIcon('power')}<span class="btn-label">${deviceLabel}</span>
              </button>`;
    }
    if (power === 'on') {
      return `<button class="quick-btn power-dynamic-quick compact labeled power-off ${this._lastSent === 'power_off' ? 'sent' : ''}"
                      data-serial-power="power_off" title="Power Off ${this._serialDevice.name}">
                ${this._getCommandIcon('power')}<span class="btn-label">${deviceLabel} Off</span>
              </button>`;
    } else if (power === 'off') {
      return `<button class="quick-btn power-dynamic-quick compact labeled power-on ${this._lastSent === 'power_on' ? 'sent' : ''}"
                      data-serial-power="power_on" title="Power On ${this._serialDevice.name}">
                ${this._getCommandIcon('power')}<span class="btn-label">${deviceLabel} On</span>
              </button>`;
    } else {
      // Unknown state - show default power button
      return `<button class="quick-btn power compact labeled ${this._lastSent === 'power_on' ? 'sent' : ''}"
                      data-serial-command="power_on" title="Power ${this._serialDevice.name}">
                ${this._getCommandIcon('power')}<span class="btn-label">${deviceLabel}</span>
              </button>`;
    }
  }

  _renderDynamicPowerButtonCompact() {
    const powerIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z"/></svg>`;
    const deviceLabel = this._getShortName(this._serialDevice.name);

    if (!this._serialDeviceState) {
      return `<button class="btn power-dynamic-compact querying" disabled>
                <span class="power-icon">${powerIcon}</span>
                <span class="power-label">${deviceLabel}</span>
              </button>`;
    }
    const { power, connected } = this._serialDeviceState;
    if (!connected) {
      return `<button class="btn power-dynamic-compact disconnected" disabled>
                <span class="power-icon">${powerIcon}</span>
                <span class="power-label">${deviceLabel}</span>
              </button>`;
    }
    if (power === 'on') {
      return `<button class="btn power-dynamic-compact power-off ${this._lastSent === 'power_off' ? 'sent' : ''}"
                      data-serial-power="power_off">
                <span class="power-icon">${powerIcon}</span>
                <span class="power-label">${deviceLabel}</span>
              </button>`;
    } else if (power === 'off') {
      return `<button class="btn power-dynamic-compact power-on ${this._lastSent === 'power_on' ? 'sent' : ''}"
                      data-serial-power="power_on">
                <span class="power-icon">${powerIcon}</span>
                <span class="power-label">${deviceLabel}</span>
              </button>`;
    } else {
      // Unknown state - show power button in neutral state
      return `<button class="btn power power-dynamic-compact ${this._lastSent === 'power_on' ? 'sent' : ''}"
                      data-serial-command="power_on">
                <span class="power-icon">${powerIcon}</span>
                <span class="power-label">${deviceLabel}</span>
              </button>`;
    }
  }

  async _sendHARemoteCommand(command) {
    if (!this._sourceDevice || !this._sourceIsHADevice || !this._sourceDevice.entity_id) return;

    // Debounce - prevent rapid fire commands
    const now = Date.now();
    if (this._lastSendTime && now - this._lastSendTime < 150) {
      return;
    }
    this._lastSendTime = now;

    try {
      await this._hass.callService('remote', 'send_command', {
        entity_id: this._sourceDevice.entity_id,
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
      console.error('Failed to send HA remote command:', e);
    }
  }

  async _sendSerialMatrixInput(commandId) {
    // Send matrix routing command for serial device via new matrix routing API
    if (!this._matrixDevice || !this._serialDeviceMatrixPort) return;

    const selectedCmd = this._matrixInputCommands.find(c => c.command_id === commandId);
    if (!selectedCmd) return;

    const inputNum = parseInt(selectedCmd.input_value, 10);
    const outputNum = this._serialDeviceMatrixPort;
    const matrixId = this._serialDeviceMatrixId;

    try {
      // Use the new matrix routing API that handles template and updates sensor state
      const resp = await fetch(`/api/vda_ir_control/matrix/${encodeURIComponent(matrixId)}/route`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: inputNum,
          output: outputNum,
        }),
      });

      if (resp.ok) {
        this._selectedMatrixInput = commandId;
        await this._loadSourceDeviceForSerial();
        this._lastSent = `Matrix: ${selectedCmd.name}`;
        this._render();

        setTimeout(() => {
          if (this._lastSent === `Matrix: ${selectedCmd.name}`) {
            this._lastSent = null;
            this._render();
          }
        }, 2000);
      } else {
        const err = await resp.json().catch(() => ({}));
        console.error('Matrix routing failed:', err.error || resp.status);
      }
    } catch (e) {
      console.error('Failed to send matrix routing command:', e);
    }
  }

  async _sendGroupPowerCommand(action) {
    if (!this._deviceGroup) return;

    this._isSendingGroupPower = action;
    this._groupPowerStatus = `Sending ${action === 'on' ? 'ON' : 'OFF'} to all devices...`;
    this._render();

    try {
      const resp = await fetch(`/api/vda_ir_control/device_groups/${this._deviceGroup.group_id}/power`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      });

      const data = await resp.json();

      if (resp.ok && data.success) {
        const successCount = data.results?.filter(r => r.success).length || 0;
        this._groupPowerStatus = `Sent ${action.toUpperCase()} to ${successCount}/${data.results?.length || 0} devices`;
      } else {
        const errors = data.results?.filter(r => !r.success).map(r => `${r.device_id}: ${r.error}`).slice(0, 2).join(', ') || 'Unknown error';
        this._groupPowerStatus = `Some failed: ${errors}`;
      }
    } catch (e) {
      console.error('Failed to send group power:', e);
      this._groupPowerStatus = 'Failed to send power command';
    }

    this._isSendingGroupPower = false;
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
        // Generated command for serial matrix - use new matrix routing API
        const inputNum = parseInt(cmd.input_value, 10);
        const outputNum = parseInt(this._device.matrix_port, 10);
        console.log('Matrix routing via API - input:', inputNum, 'output:', outputNum);

        const resp = await fetch(`/api/vda_ir_control/matrix/${encodeURIComponent(matrixId)}/route`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this._hass.auth.data.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: inputNum,
            output: outputNum,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error('Matrix routing failed:', err.error || resp.status);
          return;
        }
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

  _renderSourceRemoteContent() {
    // Render source device remote controls for serial device card
    if (!this._sourceDevice || !this._sourceCommands || this._sourceCommands.length === 0) {
      return '';
    }

    const commands = this._sourceCommands;
    const navCmds = commands.filter(c => ['up', 'down', 'left', 'right', 'enter', 'select', 'center', 'back', 'exit', 'menu', 'home', 'guide', 'info'].includes(c));
    const volCmds = commands.filter(c => c.includes('volume') || c === 'mute');
    const chanCmds = commands.filter(c => c.includes('channel') || c.includes('chan'));
    const numCmds = commands.filter(c => /^[0-9]$/.test(c));
    const playCmds = commands.filter(c => ['play', 'pause', 'play_pause', 'stop', 'rewind', 'fast_forward', 'ffwd', 'rew', 'next', 'previous'].includes(c));

    return `
      <!-- Navigation D-Pad -->
      ${navCmds.length > 0 ? `
        <div class="remote-section">
          <div class="dpad">
            <div></div>
            ${navCmds.includes('up') ? `<button class="btn" data-source-command="up"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('left') ? `<button class="btn" data-source-command="left"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>` : '<div></div>'}
            ${navCmds.includes('select') || navCmds.includes('enter') || navCmds.includes('center') ? `<button class="btn ok" data-source-command="${navCmds.includes('select') ? 'select' : navCmds.includes('center') ? 'center' : 'enter'}">OK</button>` : '<div></div>'}
            ${navCmds.includes('right') ? `<button class="btn" data-source-command="right"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>` : '<div></div>'}
            <div></div>
            ${navCmds.includes('down') ? `<button class="btn" data-source-command="down"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>` : '<div></div>'}
            <div></div>
          </div>
          <div class="nav-extras">
            ${navCmds.includes('back') ? `<button class="btn" data-source-command="back"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg> Back</button>` : ''}
            ${navCmds.includes('menu') ? `<button class="btn" data-source-command="menu">Menu</button>` : ''}
            ${navCmds.includes('home') ? `<button class="btn" data-source-command="home"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></button>` : ''}
            ${navCmds.includes('guide') ? `<button class="btn" data-source-command="guide">Guide</button>` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Volume & Channel -->
      ${volCmds.length > 0 || chanCmds.length > 0 ? `
        <div class="remote-section">
          <div class="vol-chan">
            ${volCmds.length > 0 ? `
              <div class="vol-group">
                <button class="btn" data-source-command="volume_up">Vol +</button>
                ${volCmds.includes('mute') ? `<button class="btn" data-source-command="mute">Mute</button>` : ''}
                <button class="btn" data-source-command="volume_down">Vol -</button>
              </div>
            ` : ''}
            ${chanCmds.length > 0 ? `
              <div class="chan-group">
                <button class="btn" data-source-command="${chanCmds.includes('channel_up') ? 'channel_up' : 'chanup'}">Ch +</button>
                <button class="btn" data-source-command="${chanCmds.includes('channel_down') ? 'channel_down' : 'chandown'}">Ch -</button>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Number Pad -->
      ${numCmds.length > 0 ? `
        <div class="remote-section">
          <div class="numpad">
            ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', ''].map(n =>
              n ? `<button class="btn" data-source-command="${n}">${n}</button>` : '<div></div>'
            ).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Playback Controls -->
      ${playCmds.length > 0 ? `
        <div class="remote-section">
          <div class="playback-row">
            ${playCmds.includes('rewind') || playCmds.includes('rew') ? `<button class="btn" data-source-command="${playCmds.includes('rewind') ? 'rewind' : 'rew'}">⏪</button>` : ''}
            ${playCmds.includes('play_pause') ? `<button class="btn" data-source-command="play_pause">⏯</button>` :
              (playCmds.includes('play') ? `<button class="btn" data-source-command="play">▶</button>` : '')}
            ${playCmds.includes('pause') && !playCmds.includes('play_pause') ? `<button class="btn" data-source-command="pause">⏸</button>` : ''}
            ${playCmds.includes('stop') ? `<button class="btn" data-source-command="stop">⏹</button>` : ''}
            ${playCmds.includes('fast_forward') || playCmds.includes('ffwd') ? `<button class="btn" data-source-command="${playCmds.includes('fast_forward') ? 'fast_forward' : 'ffwd'}">⏩</button>` : ''}
          </div>
        </div>
      ` : ''}
    `;
  }

  _renderHADeviceRemote() {
    // Render HA device (DirecTV, Apple TV, Roku, etc.) remote controls
    if (!this._sourceDevice || !this._sourceIsHADevice) {
      return '';
    }

    const deviceFamily = this._sourceDevice.device_family || '';
    const hasRemote = !!this._sourceDevice.entity_id;

    // DirecTV, Apple TV, Android TV, Fire TV - show full remote
    if (hasRemote && ['directv', 'apple_tv', 'android_tv', 'fire_tv', 'roku'].includes(deviceFamily)) {
      return `
        <!-- Navigation D-Pad -->
        <div class="remote-section">
          <div class="dpad">
            <div></div>
            <button class="btn" data-ha-remote="up"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg></button>
            <div></div>
            <button class="btn" data-ha-remote="left"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>
            <button class="btn ok" data-ha-remote="select">OK</button>
            <button class="btn" data-ha-remote="right"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>
            <div></div>
            <button class="btn" data-ha-remote="down"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></button>
            <div></div>
          </div>
          <div class="nav-extras">
            <button class="btn" data-ha-remote="back">Back</button>
            <button class="btn" data-ha-remote="menu">Menu</button>
            ${deviceFamily === 'directv' ? `<button class="btn" data-ha-remote="guide">Guide</button>` : ''}
            ${deviceFamily === 'directv' ? `<button class="btn" data-ha-remote="info">Info</button>` : ''}
            ${['apple_tv', 'fire_tv', 'android_tv'].includes(deviceFamily) ? `<button class="btn" data-ha-remote="home">Home</button>` : ''}
          </div>
        </div>

        <!-- Channel Controls (DirecTV) -->
        ${deviceFamily === 'directv' ? `
          <div class="remote-section">
            <div class="vol-chan">
              <div class="chan-group">
                <button class="btn" data-ha-remote="channelup">Ch +</button>
                <button class="btn" data-ha-remote="channeldown">Ch -</button>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Number Pad -->
        <div class="remote-section">
          <div class="numpad">
            ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', ''].map(n =>
              n ? `<button class="btn" data-ha-remote="${n}">${n}</button>` : '<div></div>'
            ).join('')}
          </div>
        </div>

        <!-- Playback Controls -->
        <div class="remote-section">
          <div class="playback-row">
            <button class="btn" data-ha-remote="rewind">⏪</button>
            <button class="btn" data-ha-remote="play">▶</button>
            <button class="btn" data-ha-remote="pause">⏸</button>
            <button class="btn" data-ha-remote="stop">⏹</button>
            <button class="btn" data-ha-remote="fastforward">⏩</button>
          </div>
        </div>

        ${deviceFamily === 'directv' ? `
          <div class="remote-section">
            <div class="playback-row">
              <button class="btn" data-ha-remote="record">⏺ Rec</button>
              <button class="btn" data-ha-remote="exit">Exit</button>
              <button class="btn" data-ha-remote="list">List</button>
            </div>
          </div>
        ` : ''}
      `;
    }

    // Basic HA media player controls for other devices
    return `
      <div class="remote-section">
        <div class="section-label">${this._sourceDevice.name}</div>
        <div class="nav-extras" style="justify-content: center;">
          <button class="btn" data-ha-command="media_play_pause">⏯ Play/Pause</button>
        </div>
        <p style="color: var(--secondary-text-color); font-size: 11px; text-align: center; margin-top: 8px;">
          Use the Home Assistant media player card for full controls
        </p>
      </div>
    `;
  }

  _escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  _renderCompactNowPlaying() {
    const nowPlaying = this._getNowPlayingInfo();
    if (!nowPlaying) return '';

    return `
      <div class="now-playing-compact">
        ${nowPlaying.entity_picture ? `
          <img src="${this._escapeHtml(nowPlaying.entity_picture)}" class="now-playing-image-compact" alt="">
        ` : ''}
        <div class="now-playing-info-compact">
          <span class="now-playing-title-compact">${this._escapeHtml(nowPlaying.media_title || '')}</span>
          ${nowPlaying.media_channel ? `<span class="now-playing-channel-compact">${this._escapeHtml(nowPlaying.media_channel)}</span>` : ''}
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

  _getSerialDeviceIcon() {
    if (!this._serialDevice) return '';
    const icons = {
      projector: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M22 7v10c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2zM4 17h16V7H4v10zm10-5c0-1.66-1.34-3-3-3s-3 1.34-3 3 1.34 3 3 3 3-1.34 3-3zm5-2h2v2h-2z"/></svg>`,
      hdmi_matrix: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>`,
      default: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 6H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H4V8h16v8z"/></svg>`,
    };
    return icons[this._serialDevice.device_type] || icons.default;
  }

  _getShortName(name) {
    if (!name) return '?';
    // Extract a short label from device name
    // "Bar Projector" -> "Proj", "Bar TV 1" -> "TV1", "TV 10" -> "TV10"
    const lower = name.toLowerCase();
    if (lower.includes('projector') || lower.includes('proj')) {
      return 'Proj';
    }
    // Match "TV X" or "Bar TV X" patterns
    const tvMatch = name.match(/tv\s*(\d+)/i);
    if (tvMatch) {
      return `TV${tvMatch[1]}`;
    }
    // For other names, take first 4 chars
    return name.substring(0, 4);
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
    this._serialDevices = [];
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
      const authHeader = { 'Authorization': `Bearer ${this._hass.auth.data.access_token}` };

      // Load all device types in parallel
      const [devicesResp, groupsResp, serialResp] = await Promise.all([
        fetch('/api/vda_ir_control/devices', { headers: authHeader }),
        fetch('/api/vda_ir_control/device_groups', { headers: authHeader }),
        fetch('/api/vda_ir_control/serial_devices', { headers: authHeader }),
      ]);

      if (devicesResp.ok) {
        const data = await devicesResp.json();
        this._devices = data.devices || [];
      }

      if (groupsResp.ok) {
        const data = await groupsResp.json();
        this._deviceGroups = data.groups || [];
      }

      if (serialResp.ok) {
        const data = await serialResp.json();
        this._serialDevices = data.devices || [];
      } else {
        this._serialDevices = [];
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

    // Check if it's a serial device
    if (this._config.device_id.startsWith('serial:')) {
      const serialDeviceId = this._config.device_id.replace('serial:', '');
      const serialDevice = this._serialDevices.find(d => d.device_id === serialDeviceId);
      if (serialDevice && serialDevice.commands) {
        this._availableCommands = Object.keys(serialDevice.commands);
      } else {
        this._availableCommands = [];
      }
      return;
    }

    // Find the IR device
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
            <optgroup label="IR Devices">
              ${this._devices.map(d => `
                <option value="${d.device_id}" ${this._config.device_id === d.device_id ? 'selected' : ''}>
                  ${d.name} ${d.location ? `(${d.location})` : ''}
                </option>
              `).join('')}
            </optgroup>
          ` : ''}
          ${this._serialDevices && this._serialDevices.length > 0 ? `
            <optgroup label="Serial Devices">
              ${this._serialDevices.map(d => `
                <option value="serial:${d.device_id}" ${this._config.device_id === `serial:${d.device_id}` ? 'selected' : ''}>
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

      ${this._config.device_id && (this._devices.length > 1 || (this._config.device_id.startsWith('serial:') && this._devices.length > 0)) ? `
        <div class="form-group">
          <label>Additional TV Power Buttons</label>
          <div class="help-text" style="margin-bottom: 8px;">Select other TVs to add power buttons for (e.g., TVs sharing an HDMI splitter)</div>
          <div style="max-height: 120px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 6px; padding: 8px;">
            ${this._devices.filter(d => d.device_id !== this._config.device_id && d.device_id !== this._config.device_id.replace('serial:', '')).map(d => `
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

console.info('%c VDA IR REMOTE CARD %c v1.9.19 ', 'color:#fff;background:#03a9f4;font-weight:700', 'color:#03a9f4;background:#222');
