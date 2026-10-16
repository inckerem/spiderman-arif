# DEVAM-ET — Projeyi kaldığı yerden devam ettirme rehberi

Bu dosya, bulutta (Claude Code on the web) yürütülen çalışmanın **nerede durduğunu**, **neyin kaldığını** ve **senin bilgisayarında (veya başka bir yapay zekâ ile) nasıl devam edileceğini** anlatır. Oyunun kendi belgesi `README.md`; bu dosya sadece devir-teslim içindir.

> Başka bir yapay zekâ bu projeye devam edecekse: önce bu dosyayı, sonra `CLAUDE.md`, `docs/ROADMAP.md` ve `docs/design/*.md` dosyalarını oku. Kurallar `CLAUDE.md` içinde.

---

## 1. Kısa durum (16 Ekim 2026)

Branch: **`claude/optimistic-meitner-699dlz`** (GitHub: `inckerem/spiderman-arif`). C10 entegrasyonunun derleme, hedefli test ve bağımsız inceleme kapısı tamamlandı; tam son test kapısı ve aşağıdaki yarım işler devam ediyor.

| Aşama | Konu | Durum |
| --- | --- | --- |
| M8 | Hatalar + grenlenme | ✅ Bitti (branch'te) |
| M9 | Giriş ekranında otomatik oynama + çatı anı (müzik, gece, yağmur, sinematik) | ✅ Bitti |
| M10 | Mobil dokunmatik kontroller | ✅ Bitti |
| M11 | Dövüş ve düşmanlar | 🟡 7/9 parça bitti — **boss'lar ve son cila kaldı** |
| M12 | Multiplayer, odalar, Docker, Nginx | ✅ Bitti (2 küçük iş yarım, yama dosyasında) |
| M13 | İstanbul haritası | 🟡 **C0–C10 birleştirildi ve test edildi**; sırada C11 (WIP ayrı kolda) |
| Son | Her şeyi birleştir, tam testleri iki haritada koş | ⏳ Yapılmadı |

### C10 entegrasyon kontrol noktası (16 Ekim 2026)

`223c490` (C10) mevcut dala birleştirildi; harita seçimi/kancaları, dövüş HUD’ı, suç olayları ve online/lobi birlikte korundu. Farklı harita veya özel seed’den odaya giriş doğru dünya yüklenerek sürer; davet linki haritayı taşır. Dünya kabul edilmeden welcome/paketler konum yükleyemez veya combat görünümünü değiştiremez. İlk oda saati geç bağlanan dinleyiciye aktarılır; ham test saldırıları sunucunun saldırı aralığına oda zamanı üzerinden uyar. `ws` iki açık için dar kapsamlı olarak `8.22.0` sürümüne yükseltildi; audit sıfır açık bildiriyor.

**Tamamlanan kapı:** `typecheck`, `build`, `build:server`, **67/67 Node testi**, **24/24 hedefli tarayıcı testi** (19 harita/oyun testi ve ardından 5/5 ağ testi); bağımsız incelemelerin son turunda açık bulgu yok. Tarayıcı kapısı macOS Metal ile, ağ senaryoları ayrı `5302`/`8797` portlarında koştu. Manhattan golden özeti değişmedi. **Tam 30 dakikalık soak, iki haritada nihai tam paket ve Docker/Nginx son kapısı henüz koşulmadı.**

**Sıradaki iş C11:** landmark ayrıntıları/gece ışıkları ve 12 yapı için öğlen/gece görsel incelemesi. `f1764df` (C11 WIP) ve M12 yaması bu entegrasyona uygulanmadı; C11–C13 ve sonraki işler tamamlanmış sayılmaz.

### Yarım kalan işler nerede?

| Dosya | İçerik |
| --- | --- |
| `devam/istanbul.bundle` | İstanbul kolunun (`claude/par-istanbul`) tamamı, git bundle olarak. 15 commit: C0–C10 bitmiş ve testli; en üstteki `f1764df` commit'i **C11 yarım (WIP), doğrulanmadı**. |
| `devam/wip-m12-pvp-mouse-ve-uzak-sesler.patch` | M12'nin 2 küçük açık işi (PvP odasında fareyle başka oyuncuyu hedefleme + diğer oyuncuların dövüş sesleri). **Yarım ve test edilmedi.** İstersen uygula, istersen sıfırdan yaptır. |

---

## 2. Biten işlerin özeti

- **M8 (hatalar + grenlenme):** Takılı kalan ağ ipi, bozuk tuş ayarıyla açılmayan oyun, kısa tıklamaların kaybolması vb. düzeltildi. Grenlenmenin 7 nedeni giderildi (60 Hz ekranda geri gelmeyen dinamik çözünürlük, çatı-korniş z-fighting, noktalı gölgeler, HiDPI bulanıklığı, Düşük ayarda bloklaşma, kontur benekleri, öğlen bant titremesi).
- **M9:** Menünün arkasında karakter kendi kendine ağ atarak geziyor (sinematik kamera). Oyunda bir çatıda 5 sn durunca (en az 20 sn oynadıktan ve biraz hareket ettikten sonra) `public/audio/theme.mp3` baştan başlıyor, gece oluyor, yağmur + şimşek, siyah bantlar, yörünge kamera. Herhangi bir tuş bitiriyor, saat eski haline dönüyor. Oyunun geri kalanında müzik yok.
- **M10:** Telefonda joystick, sağ yarıda kaydırarak bakış, AĞ/ÇEK/ZIPLA/DALIŞ/TIRMAN/SALDIRI butonları, duraklat; fare kilidi olmadan oynanış; dikey ekranda "çevir" uyarısı; ilk açılışta Düşük kalite.
- **M11 (1–7. parçalar):** Saf (DOM'suz) dövüş simülasyonu `src/combat/**` — hem tek oyunculuda tarayıcıda hem sunucuda aynı kod. Bağlama göre sol tık (düşman varsa kombo + atılma, yoksa ağ), sağ tık ağla çekme/yapıştırma, Boşluk ile kaçınma, F = saldırı, E = bitirme. Düşmanlar: Sokak Serserisi, Sopalı, Silahlı, Kalkanlı, Dron (instanced GPU skinning ile çiziliyor). Suç olayları, mini harita işaretleri, ışık sütunu, can barı, kombo, "KAÇ!" uyarısı, dövüş sesleri.
- **M12:** `server/` (Node + `ws`), tek port: oyun dosyaları + `/ws` + `/healthz`. Her haritanın genel odası (16 kişi, dolunca "#2"), 6 haneli kodlu özel oda + `?oda=KOD` davet linki, PvP sadece özel odada. Hareket istemcide, dövüş sunucuda. İsim kuralları + küfür filtresi, hile düzeltme/atma, yeniden bağlanma. Lobi ("Çok Oyunculu"), isim etiketleri, diğer oyuncular kendi rig/animasyonlarıyla. `Dockerfile`, `docker-compose.yml`, `deploy/nginx/skythread.conf`.
- **M13 (C0–C10, bu dala birleştirildi):** Harita soyutlaması (`src/maps/*`), tepeli zemin, su maskesi, sıkıştırılmış gerçek coğrafyalı İstanbul (Tarihi Yarımada, Haliç ve köprüleri, Galata, Boğaz ve 15 Temmuz Köprüsü, Üsküdar), landmark çarpışmaları, İstanbul'da otomatik oynama, trafik/yaya, su köpüğü, 3 yarış rotası, mini harita, İstanbul binaları/çatıları/ağaçları. Manhattan her adımda "golden" testle birebir aynı kaldı.

Ayrıntılı kararlar: `docs/ROADMAP.md` (Decisions), `docs/DECISIONS.md`, tasarımlar `docs/design/m11-m12-combat-multiplayer.md` ve `docs/design/m13-istanbul.md`, aşama kayıtları `docs/MILESTONES.md`.

---

## 3. Kalan işler (sırasıyla)

1. **M13 C11'i bitir:** landmark detayları + gece ışıkları (WIP commit `f1764df` başlangıç noktası, doğrulanmadı) ve `tests/istanbul-landmarks.spec.ts` (12 landmark, öğlen + gece, ≤ 600 draw call, ≤ 2 M üçgen). Ekran görüntülerine bakıp oranları `docs/design/m13-istanbul.md` tablosuna göre düzelt.
2. **M13 C12:** vapurlar, martılar, tramvay, balıkçılar; İstanbul'da 10 dakikalık soak.
3. **M13 C13:** İstanbul'da otomatik oynama testi, README/ARCHITECTURE/DECISIONS güncelle, iki haritada tam test.
4. **M11 parça 8 — boss'lar:** Koçbaşı (zırhlı, hücum eden dev), Kuzgun (kanatlı uçan), Diken (akrep kuyruklu). `CombatSim.bosses = true` ile her 4. olay boss olur; `startEvent('boss')` boss'u + yardımcıları doğuruyor ama boss henüz hareketsiz. Boss rig'leri (şu an en yakın türün rig'i kullanılıyor), özel saldırılar, boss can barı. Bkz. tasarım M11 §2, §10.
5. **M11 parça 9 — sertleştirme:** dövüş botu her olay türünü ve boss'ları temizlesin; fuzz/soak'a dövüş ve suç olaylarını ekle; mobilde SALDIRI yazısı butondan taşıyor; `docs/MILESTONES.md` M11 kaydı.
6. **M12 açık işler:** `devam/wip-m12-pvp-mouse-ve-uzak-sesler.patch` (PvP'de fareyle hedefleme, diğer oyuncuların dövüş sesleri) — uygula, `net.spec`'e test ekle. Tarayıcıda 15 bot + oyuncu performans ölçümü. Yeni client ile Docker'ı bir kez daha dene.
7. **Son kapı:** sakin bir makinede tam `npm test` (soak dahil), `npm run test:server`, Docker + Nginx denemesi; `README.md` ve `docs/MILESTONES.md` son hali; push.

### Bilinen sorunlar / notlar

- **Soak testi** paralel tarayıcı testleri varken bellek yetmezliğinden (OOM) öldü; tek başına çalıştır. Kodda bir hata gösterilmedi.
- Yazılım GL (SwiftShader) ile testler yavaş; zamana bağlı testler sim tick'i üzerinden ölçülmeli (touch "k" testi böyle düzeltildi).
- İstanbul üretim süresi kontrolü (< 2 sn) aşırı yük altında bir kez aştı; sakin makinede ~1 sn.
- Gerçek iPhone/Android ve gerçek GPU FPS'i hiç ölçülmedi.
- Nginx örneği yer tutucu alan adı kullanıyor: `oyun.example.com` → kendi subdomain'in (ayrıca `docker-compose.yml` içindeki `ALLOWED_ORIGINS`).
- Kalkan koparılınca / silah alınınca parça uçmuyor; şişeler gündüz soluk görünüyor (kozmetik).

---

## 4. Sana (proje sahibine) ait kurallar — bu projede nasıl çalışıldı

Bu kurallar `CLAUDE.md` dosyasında da var; Claude Code o dosyayı otomatik okur.

1. **Ana sohbette kod yazılmaz.** Ana sohbet sadece yönetir (planlar, dağıtır, kontrol eder, birleştirir, push eder). Kodu alt ajanlar yazar; her işe uygun **model ve efor** seçilir (karmaşık sim/netcode/render: güçlü model, yüksek efor; inceleme/küçük işler: daha hafif).
2. **Önce incele, sonra sor.** Büyük kararlardan önce proje incelenir ve kullanıcıya seçenekli sorular sorulur. Verilen cevaplar `docs/ROADMAP.md` → Decisions bölümünde kayıtlı; tekrar sorma, oradan uygula.
3. **Kod yazarken karşılaşılan hataları temizle.** Her aşamadan sonra ayrı bir ajan değişikliği hata için inceler, bulunanlar düzeltilir.
4. **Her aşama:** `npm run typecheck` + `npm run build` (+ `npm run build:server`) + ilgili Playwright testleri geçer → commit → push. Test asla zayıflatılmaz/atlanmaz; gerekirse kök neden düzeltilir.
5. **Oyun içi metinler Türkçe** (`src/i18n/tr.ts`); kod yorumları ve `docs/` İngilizce.
6. **Telif:** gerçek marka/karakter adı yok; boss'lar Spider-Man kötülerinden esinli ama özgün (Koçbaşı, Kuzgun, Diken); dükkân tabelaları uydurma.
7. **Paralel çalışma** istendi: ayrı `git worktree`'ler + her biri farklı port (`SKYTHREAD_DEV_PORT=5302` gibi), testler `--workers=1`; tam test paketi sadece ana kolda.
8. **Limit dostu ol:** kullanım limiti bir kez doldu. Ajanları gereksiz yere paralel çoğaltma, uzun ajan bağlamı yerine her parça için yeni ajan başlat, uzun testleri gereksiz tekrar koşma.
9. Commit mesajları açıklayıcı; aşama başına bir veya birkaç commit.

### Kullanıcının verdiği ürün kararları (özet)

- Dövüş: bağlama göre sol tık (düşman varsa saldırı, yoksa ağ); suç olayları; düşman kadrosu Spider-Man oyunlarındaki gibi (özgün isimler); PvP sadece özel odalarda.
- Multiplayer: hareket istemcide, dövüş sunucuda; oda başına 16 kişi; her haritanın kendi genel odası; özel oda kod + davet linki; kullanıcı adıyla giriş, hesap yok.
- Sunucu: Docker + Nginx, subdomain altında (alan adı henüz verilmedi).
- İstanbul: sıkıştırılmış gerçek coğrafya, yapılar gerçek boyutta; alçak gerçekçi mahalleler + tepeler; ağ noktaları minare/kubbe/köprü/ağaçtan + Levent gökdelenleri.
- Çatı anı: 5 sn hareketsiz → müzik + gece + yağmur + sinematik; tuşla biter.
- Mobil: joystick + kaydırarak kamera + butonlar, yatay ekran.
- Sıra: hatalar → otomatik mod/çatı anı → mobil → dövüş → multiplayer → İstanbul.

---

## 5. Kendi bilgisayarında nasıl devam edersin

### 5.1 Gerekenler

- **Git**
- **Node.js 22.12+** (veya 20.19+) ve npm — https://nodejs.org
- (Testler için) Playwright'in Chromium'u: `npx playwright install chromium`
- (Sunucuya kurulum için) Docker + Docker Compose
- (Yapay zekâ ile devam için) **Claude Code**: `npm install -g @anthropic-ai/claude-code`

### 5.2 Projeyi al ve çalıştır

```bash
git clone https://github.com/inckerem/spiderman-arif.git
cd spiderman-arif
git checkout claude/optimistic-meitner-699dlz
npm ci
npm run dev                 # http://127.0.0.1:5173  (tek oyunculu)
```

Multiplayer'ı yerelde denemek için ikinci bir terminalde oyun sunucusunu çalıştır (dev sunucusu `/ws` isteklerini 8787'ye yönlendirir):

```bash
npm run server:test         # 127.0.0.1:8787, test kancaları açık
# veya: npm run build:server && node dist-server/server.mjs --port=8787
```

Tek tıkla başlatıcılar (`BASLAT-Windows.bat`, `BASLAT-Mac.command`, `BASLAT-Linux.sh`) da çalışır; ayrıntılar `README.md` içinde.

### 5.3 İstanbul kolunu geri yükle (arşiv bilgisi)

C0–C10 entegrasyonu artık tamamlandı; bu komutlar temiz bir eski kopyayı geri yüklemek içindir. Mevcut dalda sıradaki iş C11’dir; WIP commit’i ayrı inceleyip doğrula.

```bash
# bundle'daki kolu yerel bir branch olarak al
git fetch devam/istanbul.bundle claude/par-istanbul:claude/par-istanbul
git log --oneline -3 claude/par-istanbul    # f1764df (WIP C11), 223c490 (C10), ...

# Önce sadece bitmiş kısmı (C10'a kadar) birleştir:
git merge 223c490
# çakışmaları çöz (app.ts, game.ts, ui.ts, minimap.ts, docs) → testleri koş → commit

# Sonra yarım C11'i ayrı ele al (ister merge et, ister cherry-pick, ister baştan yaz):
git cherry-pick f1764df   # WIP, doğrulanmadı
```

### 5.4 Yarım M12 yamasını uygula (isteğe bağlı)

```bash
git apply --3way devam/wip-m12-pvp-mouse-ve-uzak-sesler.patch
npm run typecheck && npx playwright test tests/net.spec.ts --workers=1
```

### 5.5 Testler

```bash
npm run typecheck
npm run build && npm run build:server
npm run test:server                       # Node tarafı (tarayıcısız), hızlı
npx playwright test tests/smoke.spec.ts   # tek bir test
npm test                                  # hepsi (soak dahil ~30+ dk; tek başına koş)
```

Paralel çalışacaksan her kopyada farklı port: `SKYTHREAD_DEV_PORT=5302 npx playwright test ... --workers=1`.

### Tarayıcı kurulumu ve macOS test notu

Bu makinede oyun/derleme/test araçları Node.js **26.11.1** ile çalıştı; Playwright tarayıcı kurulumu ise Node.js **24.19.0 LTS** ile tamamlandı. Node 26 ile indirme/arşiv açma adımında takılırsa, PATH üzerinde Node 24 LTS seçip proje kökünde şu komutu çalıştır:

```bash
node --version                                  # v24.19.0 ile doğrulandı
node node_modules/playwright/cli.js install chromium --only-shell
```

Bu komut Chromium Headless Shell **141.0.7390.37** (Playwright build **1194**) ve FFmpeg build **1011** kurdu. `--only-shell` bu projenin headless testleri için yeterli; görünür tarayıcı gerekiyorsa normal `npx playwright install chromium` kullanılabilir.

`playwright.config.ts`, macOS’ta ANGLE **Metal** kullanır; diğer platformlarda SwiftShader ayarı korunur. Apple M4 üzerinde zorunlu SwiftShader, readback sırasında Chromium GPU-stall uyarıları üretti. Metal denemesinde aynı İstanbul anchor sonuçları, `gl.getError() = 0` ve temiz konsol doğrulandı; testler uyarıları hâlâ hata sayar.

Kullanıcı önizlemesi `5301` ve normal oyun sunucusu `8787` portlarında çalışırken ağ testlerini ayrı süreçlerde çalıştır; Vite proxy ile test sunucusunun portu aynı ortam değişkeninden gelmeli:

```bash
SKYTHREAD_DEV_PORT=5302 SKYTHREAD_SERVER_PORT=8797 npx playwright test tests/net.spec.ts --workers=1
```


### 5.6 Claude Code ile devam

Proje klasöründe `claude` komutunu çalıştır. `CLAUDE.md` otomatik okunur. İlk mesaj olarak şunu yazabilirsin:

> `DEVAM-ET.md`, `CLAUDE.md`, `docs/ROADMAP.md` ve `docs/design/` dosyalarını oku. Bölüm 3'teki sıradaki işten devam et. Kurallara uy: ana sohbette kod yazma, alt ajan kullan, her aşamada test et, commit et, push et.

### 5.7 Sunucuya kurulum (Docker + Nginx)

```bash
# sunucuda, proje klasöründe
# 1) deploy/nginx/skythread.conf ve docker-compose.yml içindeki oyun.example.com'u kendi subdomain'inle değiştir
docker compose up -d --build
curl -f http://127.0.0.1:8080/healthz
# 2) deploy/nginx/skythread.conf'u Nginx'e ekle (sites-available → sites-enabled), sertifikayı al, nginx -t && systemctl reload nginx
```

Ayrıntılar ve ortam değişkenleri tablosu: `README.md` → "Sunucuya kurulum / Deploy".
