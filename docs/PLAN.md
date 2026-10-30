# Development Plan

Rencana pengembangan setelah v0.1.1. Urutan rilis: 0.2.0 → 0.3.0 → 0.4.0.

## Keputusan

- Tab ssh langsung tertutup saat proses keluar, sama seperti shell. Tidak ada layar reconnect.
- Dependency baru: `tauri-plugin-dialog` (file picker). Crate `ignore` tidak dipakai karena mention `@` tidak dikerjakan.
- Attachment: Claude Code penuh (file dan gambar). Agent lain hanya menerima referensi path di teks prompt; tombol attach gambar diberi label "belum didukung penuh" untuk agent tersebut.
- Mention `@` file tidak dikerjakan (khawatir berat).

## Kondisi awal (v0.1.1)

- Tombol `+` hanya memanggil `newTab()` (`ui/app.js`). `pty_spawn` selalu menjalankan `$SHELL -l` (`src-tauri/src/pty.rs`); satu-satunya opsi adalah `config.shell`.
- Context menu hanya ada untuk pane dan terikat ke objek `pane` (`showContextMenu`).
- `pty_foreground` menganggap shell idle bila `pgid == pid shell`. Agent tools bergantung pada nilai ini.
- Composer hanya berisi textarea, checkbox konteks terminal, tombol agent, dan Send. Prompt dikirim sebagai string polos lewat stdin atau args (`PromptVia` di `agents.rs`).
- `clipboard.rs` hanya membaca teks (`pbpaste`).
- Hanya Claude Code yang terpasang di mesin pengembang. Flag agent lain harus diverifikasi ke dokumentasi atau `--help` masing-masing sebelum diimplementasi (lihat CONTRIBUTING).

---

## 0.2.0: Profil dan menu `+`

### Model data (`config.rs`)

```
Profile { id, name, kind: "shell" | "ssh" | "command",
          shell/command, args, ssh_host (alias), cwd, env }
AppConfig += profiles: Vec<Profile>, default_profile: String
```

- Field `shell` lama dimigrasikan menjadi profil "Default shell" (pola yang sama dengan migrasi legacy yang sudah ada).
- Backend menerima `profile_id` dan me-resolve command dari config. UI tidak mengirim command mentah.
- Tidak ada field password. SSH memakai key atau ssh-agent; password diketik di PTY.

### Backend

1. Modul baru `sshconfig.rs` dengan command `ssh_hosts()`: parse `~/.ssh/config`, ikuti `Include`, abaikan `Host *`/wildcard dan baris yang di-comment, dukung `Host a b`. Hasil: `{alias, hostname, user}`.
2. `pty_spawn` menerima `profile`. Untuk ssh, PTY langsung menjalankan `ssh <alias>` sehingga `ProxyJump`, `LocalForward`, dan `IdentityFile` tetap dibaca ssh sendiri.
3. `pty_foreground`: untuk profil non-shell, laporkan `shell_idle = false` dan `name = "ssh"`. Tanpa ini sesi remote dianggap prompt lokal oleh agent tools.
4. Deteksi shell terpasang dari `/etc/shells` untuk menu "Add profile".

### UI (`ui/profiles.js`)

- Klik kiri `+` = tab dengan profil default. Klik kanan `+` dan chevron `⌄` membuka menu: bagian Local, bagian SSH, lalu "Kelola profil…".
- Profil default ditandai ✓. "Jadikan default" lewat klik kanan item (atau ⌥-klik) dan lewat Settings → Profiles (section baru: daftar, tambah/edit/hapus, dropdown default).
- Refactor `showContextMenu(pane, x, y)` menjadi `showMenu(entries, x, y)` yang generik; menu pane memakainya.
- ⌘T memakai profil default. Shortcut profile picker opsional di `keys.js`.
- Tab ssh memakai nama host sebagai judul awal dan chip "ssh".
- Boot pertama memakai profil default.
- Semua string baru ditambahkan di `i18n.js` untuk `en` dan `id`.

### Tes dan risiko

- Unit test Rust: parser ssh config (Include, wildcard, multi-alias, `Match`), migrasi `shell` → profil.
- Manual: koneksi sukses, host tidak terjangkau, passphrase prompt, resize saat di ssh, agent `run_command` di pane ssh.
- Cwd yang diwarisi dari pane aktif tidak boleh diteruskan ke profil ssh.
- Opsional (fase lanjutan): `open_pane` di MCP menerima parameter `profile`, tetap lewat Command Guard dengan subjek `ssh <host>`.

---

## 0.3.0: Attachment

### Arsitektur

- UI membangun pesan terstruktur `{text, attachments[]}`, bukan string. `SendArgs` mendapat `attachments`; setiap `build_*` di `agents.rs` menerjemahkannya sesuai kemampuan agent.
- Tiap `Spec` mendapat flag kemampuan (`images`, `add_dir`).
- Modul baru: `ui/composer.js`, `attachments.rs` (staging dan limit).
- Langkah 0: ekstrak helper (`el`, `$`, `esc`, `invoke`) dari `app.js` ke `ui/util.js`.

### Fitur

- Tiga cara menambah: tombol 📎 (`tauri-plugin-dialog`), drag & drop (`onDragDropEvent` Tauri, karena HTML5 drop tidak memberi path), dan paste gambar (`clipboardData.files`).
- Bytes dari paste disimpan ke `~/.config/yuxoterm/attachments/` (izin 0700), dengan batas ukuran dan tipe serta pembersihan setelah sesi.
- Chip attachment di atas textarea (nama, ukuran, ×), thumbnail untuk gambar. Thumbnail memakai data URI (CSP sudah mengizinkan `data:`); scope asset protocol tidak diperluas.
- Penyampaian ke agent:
  - File/folder dirujuk lewat path di prompt. Path di luar cwd memakai `--add-dir` untuk Claude.
  - Gambar untuk Claude: uji mana yang andal di `-p` antara path yang dibaca tool Read dan `--input-format stream-json` dengan blok image.
  - Agent lain: referensi path di teks. Dukungan gambar penuh per agent ditambahkan kemudian setelah flag-nya diverifikasi.
- Tampilkan attachment di bubble pesan dan rekam di history secara replayable. `loadSession` saat ini hanya mengambil blok `text`, jadi blok image harus ditangani agar tidak hilang diam-diam.
- Peringatan konfirmasi untuk file sensitif (`.env`, kunci SSH) bila kontennya di-inline oleh app, karena itu tidak melewati Command Guard.

---

## 0.4.0: Slash command, skill, dan fungsi chat lain

### Slash command dan skill

Prasyarat: uji di mesin pengembang apakah `/nama-skill` benar-benar dieksekusi di `claude -p` dan apakah event `system/init` stream-json memuat daftar `skills`/`slash_commands`.

- Mengetik `/` di awal prompt membuka menu dengan dua sumber:
  1. Built-in YuxoTerm (client-side): `/new`, `/history`, `/model`, `/agent`, `/effort`, `/thinking`, `/context`.
  2. Native Claude: skill dan command dari `~/.claude/skills`, `<cwd>/.claude/skills`, `.claude/commands`, dan plugin (parse frontmatter name dan description).
- Daftar dari filesystem dipakai lebih dulu, lalu diperbarui dari event init setelah pesan pertama.
- Fase lanjutan: untuk agent selain Claude, ekspansi file command markdown menjadi teks prompt (ganti `$ARGUMENTS`).

### Fungsi chat lain

| Prioritas | Fungsi |
|---|---|
| Tinggi | Riwayat prompt (↑/↓, tersimpan), draft per tab, antrian pesan saat agent sibuk (`Chat.send` sekarang mengabaikan input saat busy), tombol copy pada pesan dan code block, edit/kirim ulang pesan terakhir |
| Sedang | Usage/biaya dari event `result`, ganti mode permission per tab, konteks terminal sebagai chip yang bisa dipilih |
| Rendah | Export chat ke markdown |

---

## Rilis

| Rilis | Isi | Ukuran kasar |
|---|---|---|
| 0.2.0 | Profil dan menu `+` | 3–5 hari |
| 0.3.0 | Attachment | ± 1 minggu |
| 0.4.0 | Slash/skill dan fungsi chat lain | ± 1 minggu |

Ukuran adalah perkiraan kasar. Naikkan versi di `package.json`, `Cargo.toml`, dan `tauri.conf.json` sesuai CONTRIBUTING. Sebelum merge jalankan `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, dan `cargo test`, sama seperti CI.
