# Aircon

A simple, fast web app for controlling an **Airzone** system from your phone. One screen: every zone,
its temperature and humidity, a big power button, and a target temperature you can nudge with − / +.
Mode (cool / heat / fan / dry / auto / stop) and "all on / all off" sit at the top.

No ads, no Cloud Plan upsell, no menus.

It is a tiny Node.js server (no dependencies) that you run on any always-on machine at home — a
Raspberry Pi, a NAS, an old laptop. Your phone opens it in the browser and you add it to the home
screen, after which it behaves like an app.

## Two ways to talk to Airzone

| | **Local** (recommended) | **Cloud** |
|---|---|---|
| How | Directly to your Airzone Webserver on the Wi-Fi (Local API, port 3000) | The same Airzone Cloud servers the official app uses |
| Needs | The Webserver's IP address | Your normal Airzone Cloud email + password (free account) |
| Internet | Not needed | Needed |
| Speed | Instant | A second or two |

There is also a **Demo** mode with fake zones so you can try the app first.

## Getting started

You need Node.js 18 or newer.

```sh
npm start
```

Open `http://<that-machine's-ip>:8080` on your phone, tap the ⚙︎ button, and pick a connection:

- **Local**: tap **Find it on my network** (scans your home network for the Webserver) or type the
  IP from your router's device list. Port is normally `3000`.
- **Cloud**: type your Airzone Cloud email and password.

Tap **Save & connect**. Settings are only saved if the connection works. They live in
`data/config.json`, which is git-ignored and readable only by the user running the server.

Then add it to your home screen: in Safari, Share → **Add to Home Screen**; in Chrome, ⋮ → **Install app**.

You can also find the Webserver from the command line:

```sh
npm run discover
```

### If Local mode can't connect

- The phone/server and the Airzone Webserver must be on the same network.
- Some Webservers (e.g. the Webserver Hub) need the **Local API** switched on. It's in the official
  Airzone app's Webserver settings; the exact place moves between app versions.
- Older Airzone Webservers (pre-2020 firmware) may not have the Local API at all. Use Cloud mode instead.
- Give the Webserver a fixed IP (DHCP reservation in your router) so it doesn't move.

## Configuration through environment variables

Handy for Docker or a systemd service. These override the saved settings.

| Variable | Meaning |
|---|---|
| `PORT` | Port the app listens on (default `8080`) |
| `AIRZONE_HOST` | Webserver IP → Local mode |
| `AIRZONE_PORT` | Webserver port (default `3000`) |
| `AIRZONE_EMAIL`, `AIRZONE_PASSWORD` | Cloud login → Cloud mode |
| `AIRZONE_MODE` | Force `local`, `cloud` or `demo` |
| `AIRCON_PIN` | If set, the app asks for this PIN once per device before it does anything |
| `AIRCON_CONFIG` | Where to store settings (default `data/config.json`) |

### Docker

```sh
docker build -t aircon .
docker run -d --name aircon --restart unless-stopped --network host -v aircon-data:/app/data aircon
```

`--network host` lets **Find it on my network** see your home network. If you set `AIRZONE_HOST`
yourself you can use `-p 8080:8080` instead.

### Raspberry Pi / Linux, without Docker

```ini
# /etc/systemd/system/aircon.service
[Unit]
Description=Aircon
After=network-online.target

[Service]
WorkingDirectory=/home/pi/aircon
ExecStart=/usr/bin/node server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now aircon
```

## Security

The app has no login by default, so anyone on your home Wi-Fi can use it. Set `AIRCON_PIN` if that
bothers you. Don't expose it to the internet. To use it away from home, use a VPN such as Tailscale,
or switch to Cloud mode and run it wherever you like.

## Development

```sh
npm test
```

The tests run the real code against fake Airzone devices (`test/fakes.js`) for both the Local API
and the Cloud API.

```
server.js          HTTP server + JSON API used by the page
lib/local.js       Airzone Local API backend
lib/cloud.js       Airzone Cloud backend
lib/demo.js        Fake zones
lib/discover.js    Network scan for Webservers
public/            The app (plain HTML/CSS/JS, installable as a PWA)
```

### API

| Method | Path | Body |
|---|---|---|
| GET | `/api/state` | — |
| POST | `/api/zones/:id` | `{ "on": true }` and/or `{ "setpoint": 23.5 }` |
| POST | `/api/systems/:id/mode` | `{ "mode": "cool" }` |
| POST | `/api/systems/:id/power` | `{ "on": false }` |
| POST | `/api/all/power` | `{ "on": false }` |
| GET/POST | `/api/config` | `{ "mode": "local", "host": "192.168.1.50" }` |
| POST | `/api/discover` | — |

So you can also script it. For example, turn everything off at midnight with cron:

```sh
curl -X POST localhost:8080/api/all/power -H 'Content-Type: application/json' -d '{"on":false}'
```

---

Not affiliated with Airzone. The Cloud API isn't officially documented. This app uses it the way the
open-source Home Assistant integration does, so a change on Airzone's side could break Cloud mode.
Local mode uses Airzone's published Local API.
