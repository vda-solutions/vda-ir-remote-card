# VDA IR Remote Card

A Lovelace card for Home Assistant that provides a beautiful remote control interface for your IR-controlled devices.

## What This Does

The Remote Card gives you a touch-friendly remote control for any device managed by VDA IR Control:

- **Device Selection** - Quick dropdown to switch between your controlled devices
- **Device Groups** - Control multiple devices with a single power button
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

1. Open HACS
2. Click the menu icon and select **Custom repositories**
3. Add: `https://github.com/vda-solutions/vda-ir-remote-card`
4. Type: **Dashboard**
5. Click **Add**
6. Download "VDA IR Remote Card"
7. Hard refresh browser (Ctrl+Shift+R)

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
| `device_id` | string | none | Pre-select a specific IR device |
| `group_id` | string | none | Pre-select a device group |
| `name` | string | device name | Custom display name |
| `quick_buttons` | list | [] | List of command IDs for quick access buttons |

### Example Configurations

**Single Device:**
```yaml
type: custom:vda-ir-remote-card
device_id: living_room_tv
quick_buttons:
  - power
  - volume_up
  - volume_down
  - mute
```

**Device Group:**
```yaml
type: custom:vda-ir-remote-card
group_id: all_tvs
name: All TVs
```

## Features

### Device Groups
Create groups of devices in the Admin Card and control them together. The group card displays a compact view with a power button that sends commands to all member devices with configurable delay.

### Adaptive Layout
The remote automatically shows relevant controls based on your device type:
- **TV**: Channel controls, input selection
- **Soundbar**: Volume focus, sound modes
- **Streaming**: Playback controls, home button
- **AV Receiver**: Input selection, audio modes

### HDMI Matrix Integration
If your device is linked to an HDMI matrix, the remote shows a compact header with power button and input dropdown for quick control.

### Quick Buttons
Configure quick access buttons in the card editor. Select from available commands in your device profile using the checkbox interface.

### Touch-Friendly Design
Large buttons with visual feedback make it easy to use on tablets and phones. All icons use crisp SVG graphics for any screen size.

## Requirements

- Home Assistant 2023.1 or newer
- [VDA IR Control Integration](https://github.com/vda-solutions/vda-ir-control) v1.6.0 or newer
- At least one controlled device configured via the Admin Card

## Changelog

### v1.6.0
- Added Device Groups support with group power control
- Compact card layout with inline power button and input dropdown
- Quick buttons now configurable via checkbox selection
- All icons converted to SVG for crisp display
- Improved vertical alignment and spacing

## License

MIT License - See [LICENSE](LICENSE) for details.
