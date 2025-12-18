# VDA IR Remote Card

A Lovelace card for Home Assistant that provides a beautiful remote control interface for your IR-controlled devices.

## What This Does

The Remote Card gives you a touch-friendly remote control for any device managed by VDA IR Control:

- **Device Selection** - Quick dropdown to switch between your controlled devices
- **Power Controls** - Power on/off with visual feedback
- **Volume Controls** - Volume up/down and mute
- **Navigation** - D-pad navigation with select button
- **Quick Actions** - Customizable buttons for frequently used commands
- **All Commands** - Access every command in your device profile
- **HDMI Matrix** - Integrated input selection for linked matrix switches

## Part of the VDA IR Control Ecosystem

This card is one component of the complete VDA IR Control system:

| Repository | Purpose | Required |
|------------|---------|----------|
| [vda-ir-control](https://github.com/vda-solutions/vda-ir-control) | Home Assistant Integration | Yes |
| [vda-ir-control-admin-card](https://github.com/vda-solutions/vda-ir-control-admin-card) | Admin/Management Card | Yes |
| **vda-ir-remote-card** | Remote Control Card (this repo) | Optional |
| [vda-ir-firmware](https://github.com/vda-solutions/vda-ir-firmware) | ESP32 Firmware | Yes |
| [vda-ir-profiles](https://github.com/vda-solutions/vda-ir-profiles) | Community IR Profiles | Optional |

## Installation

### Via HACS (Recommended)

1. Open HACS in Home Assistant
2. Go to **Frontend** section
3. Click the three dots menu → **Custom repositories**
4. Add `https://github.com/vda-solutions/vda-ir-remote-card` as a **Lovelace** type
5. Click **Install**
6. Restart Home Assistant

### Manual Installation

1. Download `vda-ir-remote-card.js` from the [latest release](https://github.com/vda-solutions/vda-ir-remote-card/releases)
2. Copy to your `config/www/` folder
3. Add the resource in Lovelace:
   - Go to **Settings** → **Dashboards** → **Resources**
   - Add `/local/vda-ir-remote-card.js` as JavaScript Module

## Usage

Add the card to your dashboard:

```yaml
type: custom:vda-ir-remote-card
```

### Card Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `device_id` | string | none | Pre-select a specific device |
| `show_all_commands` | boolean | false | Show all commands by default |

### Example Configuration

```yaml
type: custom:vda-ir-remote-card
device_id: living_room_tv
```

## Features

### Adaptive Layout
The remote automatically shows relevant controls based on your device type:
- **TV**: Channel controls, input selection
- **Soundbar**: Volume focus, sound modes
- **Streaming**: Playback controls, home button
- **AV Receiver**: Input selection, audio modes

### HDMI Matrix Integration
If your device is linked to an HDMI matrix, the remote shows input selection buttons that control both the matrix and the device.

### Touch-Friendly Design
Large buttons with haptic feedback indicators make it easy to use on tablets and phones.

## Requirements

- Home Assistant 2023.1 or newer
- [VDA IR Control Integration](https://github.com/vda-solutions/vda-ir-control) installed
- At least one controlled device configured via the Admin Card

## License

MIT License - See [LICENSE](LICENSE) for details.
