# YF Ticker — `yfticker@kahsky`

A Cinnamon desklet that displays a modern horizontal scrolling stock ticker using real-time data from Yahoo Finance.

> *"One is glad to be of service."* — Bicentennial Man

**Author:** Karl Bustamante (kahsky)
**License:** GNU General Public License v3.0

---

## Features

- Horizontal auto-scrolling ticker bar
- Real-time quotes from Yahoo Finance (crumb/cookie auth)
- Configurable symbol list (one per line)
- Shows: trend icon (▲▼●), price, currency symbol, absolute change, percent change
- Trend colors: green / red / gray (fully customizable)
- Appearance: width, height, background color, opacity, corner radius, border
- Custom font size and color
- Adjustable scroll speed (~60 fps)
- Supports both `libsoup` and external `curl` for HTTP requests
- Authorization parameters cached between sessions
- Up to 5 simultaneous instances

---

## Installation

### Method 1 — Manual (recommended)

1. Copy the desklet folder into your Cinnamon desklets directory:

```bash
cp -r yfticker@kahsky ~/.local/share/cinnamon/desklets/
```

2. Restart Cinnamon:

```bash
cinnamon --replace &
```

3. Right-click the desktop → **Add Desklets**
4. Search for **YF Ticker** and click **+**

### Method 2 — From this repository

```bash
git clone https://github.com/kahsky/yfticker.git
cp -r yfticker/yfticker@kahsky ~/.local/share/cinnamon/desklets/
cinnamon --replace &
```

---

## Configuration

Right-click the desklet → **Configure** to access the settings panel.

| Tab | Options |
|-----|---------|
| **Quotes** | Symbol list, update frequency, manual refresh |
| **Display** | Trend icon, price, currency, absolute/percent change, trend colors |
| **Appearance** | Width, height, scroll speed, background, opacity, border, font |
| **Network** | Custom User-Agent, curl path, apply/reset network settings |

### Symbols

Enter one ticker symbol per line in the **Quotes** tab. Lines starting with `;` are ignored (can be used as comments).

```
AAPL
MSFT
NVDA
GOOGL
AMZN
```

---

## Enabling Debug Logs

Create an empty file named `DEBUG` in the desklet folder:

```bash
touch ~/.local/share/cinnamon/desklets/yfticker@kahsky/DEBUG
```

Logs will appear in `~/.xsession-errors` or via `journalctl`.

---

## Files

| File | Description |
|------|-------------|
| `desklet.js` | Main desklet logic |
| `lib/util-extract.js` | Async subprocess helper |
| `metadata.json` | Desklet metadata (UUID, name, version) |
| `settings-schema.json` | Settings definition |
| `stylesheet.css` | Visual styles |
| `README.md` | This file |
| `LICENSE` | GNU GPL v3 license |

---

## License

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

See the [LICENSE](LICENSE) file for the full license text.
