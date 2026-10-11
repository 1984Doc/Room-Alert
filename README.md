# RoomFlow — Save & Load / Save & Clean for OSCAR EMR

When the physician finishes a visit, the billing screen's **Save** button becomes two
buttons: **Save & Load** and **Save & Clean**. Within a few seconds, every reception
PC shows a card with the **room name in its Oscar colour** and the action
(LOAD or CLEAN & LOAD). One receptionist clicks **Got it** and the card clears on
every screen.

- No Oscar database access. Rooms are read from the Oscar schedule page in the browser.
- No patient names or health card numbers are sent or stored.
- Tested with OSCAR 19 (Ontario billing). The page addresses for Carlos EMR are
  included but less tested.

```
Billing review page (physician)        RoomFlow server                 Schedule page (reception)
[Save & Load] [Save & Clean]  ──►   relays the task           ──►    ┌───────────────────────┐
        │                            (small Python app)               │ Smith 2  (room colour) │
        └─► then Oscar's own Save                                     │ CLEAN & LOAD  [Got it] │
                                                                      └───────────────────────┘
```

## What's in this package

| File | Goes on | Purpose |
|---|---|---|
| `server/app.py` | server | the relay (Flask + Waitress) |
| `server/requirements.txt` | server | Python packages |
| `server/config.example.toml` | server | copy to `config.toml` and edit |
| `server/roomflow.service` | server | runs it at boot and restarts it if it stops (systemd) |
| `userscript/oscar-roomflow.user.js` | every office PC | Tampermonkey script, used by physicians and reception |

---

## 1. Set up your rooms in Oscar

Each exam room is a custom **appointment status** (Administration → Schedule
Management → Appointment Status), with its own colour.

**Room names must end in a number**, e.g. `Smith 1`, `Smith 2`, `Jones 1`, `Room 3`.
Oscar's built-in statuses (To Do, Here, Picked, Empty Room, No Show, Cancelled,
Billed, Signed, Verified…) are never treated as rooms. To change the rule, edit
`ROOM_TITLE_INCLUDE` near the top of the userscript. Setting it to `null` accepts
every custom status.

Staff set the patient's status to their room when they're roomed, as usual.

---

## 2. Server setup (Ubuntu / Debian)

Any always-on Linux machine works: an office PC, a small server, or a home server
reached through DDNS. Python 3.8 or newer is required (`python3 --version`).

### Install

Put the four `server/` files in one folder, e.g. `/home/youruser/roomflow`, then:

```bash
cd /home/youruser/roomflow
sudo apt install python3-venv           # if "python3 -m venv" says it's missing
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp config.example.toml config.toml
nano config.toml
```

In `config.toml`:

- `api_token`: a long random string. Generate one with
  `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.
  The same value goes in the userscript.
- `allowed_networks`: who may connect, as **IP ranges only** (no hostnames, no ports).
  - `[]` = anyone who has the token
  - `["192.168.0.0/24"]` = only that office network (server on the same network)
  - `["OFFICE.PUBLIC.IP/32"]` = only the office, when the server is elsewhere
    (find the office's public IP at https://ifconfig.me from an office PC)

### Quick test (two terminals)

Terminal 1, from the folder with `app.py`:
```bash
venv/bin/python app.py          # prints "Serving on http://0.0.0.0:8765" and waits
```
Terminal 2:
```bash
curl http://localhost:8765/health          # → {"ok":true}
```
Press Ctrl+C in terminal 1 when done.

### Run it as a service (starts at boot, restarts if it stops)

Edit three lines in `roomflow.service` to match your user and folder:
```ini
User=youruser
WorkingDirectory=/home/youruser/roomflow
ExecStart=/home/youruser/roomflow/venv/bin/python app.py
```
Then:
```bash
sudo cp roomflow.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roomflow
systemctl status roomflow                   # should say "active (running)"
```

Use either this service or a crontab `@reboot` line, not both. Two copies would
compete for the port.

### Day-to-day commands

```bash
systemctl status roomflow                   # running?
journalctl -u roomflow -f                   # live log (Ctrl+C to exit)
sudo systemctl restart roomflow             # after editing config.toml or app.py
```

The log shows every button press, every "Got it", and any rejected request:
```
NOTIFY NEW CLEAN | room=Smith 2 | appt=12345 | from 203.0.113.10
ACK CLEAN | room=Smith 2 | by Reception | from 203.0.113.10
REJECTED (wrong token) ...            → API_TOKEN in the script ≠ api_token in config.toml
REJECTED (address not allowed) ...    → add that address to allowed_networks
```

### Firewall and network

- If `ufw` is on: `sudo ufw allow 8765/tcp`
- **Server outside the office** (e.g. at home behind DDNS): forward TCP port 8765 on
  that router to the server's local IP. Test from an office PC (or a phone on
  cellular) with `http://YOUR-DDNS-NAME:8765/health`. Testing from inside the
  server's own network doesn't prove the port forward works.

### Strongly recommended if the server is reached over the internet: HTTPS

Without HTTPS, the token, room names and appointment numbers travel unencrypted.
Caddy adds a free certificate automatically:

1. Forward ports **80 and 443** to the server (the 8765 forward can then be removed).
2. `sudo apt install caddy`, then set `/etc/caddy/Caddyfile` to:
   ```
   your-ddns-name.example.net {
       reverse_proxy 127.0.0.1:8765 {
           header_up X-Real-IP {remote_host}
       }
   }
   ```
   and run `sudo systemctl reload caddy`.
3. In `config.toml`: `bind = "127.0.0.1"` and `behind_proxy = true`, then restart RoomFlow.
4. In the userscript: `SERVER_URL = 'https://your-ddns-name.example.net'` and
   `@connect your-ddns-name.example.net`.

---

## 3. Userscript setup (every office PC: physicians and reception)

1. Install the **Tampermonkey** browser extension. In Chrome or Edge, go to
   `chrome://extensions` → Tampermonkey → **Details** → turn on
   **Allow User Scripts**.
2. Tampermonkey → **Create a new script**, paste `oscar-roomflow.user.js`, and edit:
   ```js
   // @connect      YOUR-SERVER-HOSTNAME-OR-IP
   const SERVER_URL = 'http://YOUR-SERVER-HOSTNAME-OR-IP:8765';
   const API_TOKEN  = 'same value as api_token in config.toml';
   ```
   The hostname in `@connect` must match the one in `SERVER_URL`. Press Ctrl+S.
   If Tampermonkey asks to allow connecting to the server, choose **Always allow**.
3. Open Oscar, click the Tampermonkey icon, and choose a role. It's saved for that
   browser, so you only do this once per PC:
   - **RoomFlow role: Physician** on physicians' PCs
   - **RoomFlow role: Receptionist** on front-desk PCs, plus
     **RoomFlow: set my name** so the card shows "✓ name" when acknowledged
4. Reception: click once anywhere on the schedule after opening it, so the
   browser allows the chime.

The script runs on any Oscar address containing `/oscar…/`. If your Oscar is at a
different path, adjust the `@match` / `@include` lines.

---

## How it works

**Finding the room.** On the schedule, each appointment's status icon is a link
like:
```html
<a class="apptStatus" onclick="...appointment_no=12345..." title="Smith 2 ">
```
Every time any office PC shows the schedule, the script remembers, per appointment,
the last **room** status it saw, along with the colour behind that link. It
re-checks on every Oscar auto-refresh and every 15 seconds. Non-room statuses
(Here, Billed…) never overwrite it, so when Oscar changes the appointment to
Billed, the room is still remembered. The memory is kept in each browser for 12 hours.

**Billing.** The billing review page carries the appointment number in a hidden
field. Save & Load or Save & Clean sends the action, the appointment number and
your PC's remembered room to the server, then clicks Oscar's real Save button, so
Oscar's validation and save are unchanged.

**Reception.** Each reception PC checks the server every 3 seconds. It compares
the physician's remembered room with its own, and the most recent sighting wins.
New cards chime. "Got it" clears the card on every reception PC. Acknowledged cards
stay greyed out for 30 seconds, and unacknowledged ones expire after 4 hours. Both
times can be changed under `[tasks]` in `config.toml`.

**If the server can't be reached,** the physician gets a pop-up saying reception
was NOT notified, and the bill still saves. Reception's panel shows "offline".

---

## Troubleshooting

Tampermonkey icon → **RoomFlow: diagnose this page** shows what the script sees.

| Symptom | Check |
|---|---|
| Save button not split | Role is Physician? "Billing page?" says YES? Is "Save" listed under Buttons? Is Allow User Scripts on? |
| "Reception was NOT notified" pop-up | `/health` reachable from that PC? `SERVER_URL` and `@connect` correct? Look for REJECTED in the server log |
| Card says "Room not identified" | On the schedule, with the patient in a room, diagnose should list `#12345 Smith 2 #xxxxxx = ROOM`. If it says "not a room", the status name doesn't end in a number (see `ROOM_TITLE_INCLUDE`). The test patient must be shown in the room on a schedule screen *before* billing |
| Reception panel says offline | Server running (`systemctl status roomflow`)? Network or port forward? |
| `ModuleNotFoundError: tomllib` | Older Python: `venv/bin/pip install -r requirements.txt` (installs `tomli`) |
| "No such file or directory" starting the server | Run it from the folder containing `app.py` and `venv`: `venv/bin/python app.py` |

## Customising

All in the CONFIG section at the top of the userscript:

- **Panel position on the reception screen:** search for `roomflow-panel` and
  change `right: '10px'` / `bottom: '10px'` (bigger numbers move it left or up),
  or use `left: '10px'` to pin it to the left side.
- **Button labels and colours:** `ACTIONS`.
- **What counts as a room:** `ROOM_TITLE_INCLUDE` / `ROOM_TITLE_EXCLUDE`.
- **Polling speed:** `POLL_MS` (default 3000 ms).
