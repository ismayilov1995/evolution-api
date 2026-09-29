# Bu fork upstream-dən nə ilə fərqlənir

Bu repo [Evolution API](https://github.com/EvolutionAPI/evolution-api)-nin
forkudur. Yuxarı axından (upstream) fərqi **5 commit**-dir; hamısı canlı
istifadədə üzə çıxan və hər biri **səssiz** işləyən nasazlıqların düzəlişidir.
Aşağıdakı üçü ona görə vacibdir ki, üçü də xəta çıxarmır — sadəcə məlumat itir.

Tam izah hər commit-in mətnindədir (`git log`), burada qısası verilir.

## 1. Deşifrə oluna bilməyən mesajlar itmirdi → yazılır

`3d088d40`, `bc785e67` — `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

Signal deşifrəsi uğursuz olanda (`Bad MAC`, `No session found`) Baileys bir
«stub» qaytarır. Upstream sadəcə xəbərdarlıq loglayıb keçirdi — mesaj `Message`
cədvəlinə **ümumiyyətlə düşmürdü**. Nəticədə söhbətdə heç nə görünmür, cavab
vaxtı hesablayan statistika isə «müştəri heç yazmayıb» qənaətinə gəlirdi. İtən
mesajın ən pis xüsusiyyəti budur: yoxluğu sükutdan seçilmir.

İndi `messageType = 'undecryptable'` olan yer tutucu sətir yazılır, səbəb
`conversation` sahəsində saxlanılır. Göndərən cihaz mesajı yenidən göndərəndə
yer tutucu silinir.

Bu deploy-da müşahidə olunan: 3 gündə 13 mesaj, əsasən servis yenidən
başladıqdan sonrakı bir saat ərzində.

> **Diqqət — bazadakı unikal indeks.** Bu quraşdırmada `(instanceId, key->>'id')`
> üzərində unikal indeks var (dublikat sətirlərin qarşısını almaq üçün). Onsuz
> ikinci commit-in mənası yoxdur; onunla isə tarixçə sinxronizasiyası yer
> tutucunu «əvəz edə bilmir» problemi yaranır ki, məhz `3d088d40` onu həll edir.

## 2. Oxuna bilməyən sessiya yenisi ilə əvəz olunurdu

`d1420f8e` — `src/utils/use-multi-file-auth-state-prisma.ts`

Prisma auth-state provayderi «sessiya yoxdur» ilə «sessiyanı oxuya bilmədim»
hallarını eyni sayırdı: hər ikisi `null` qaytarırdı. Baza timeout-u və ya
tükənmiş bağlantı hovuzu da `null` verirdi — və növbəti sətir **yeni, qoşulmamış
kimlik yaradıb işlək sessiyanın üstünə yazırdı**. Praktikada bu, WhatsApp
nömrəsinin qoşulmasının itməsi və yenidən QR oxutmaq deməkdir.

İndi oxuma xətası ilə «yoxdur» bir-birindən ayrılır.

## 3. S3 yükləmələri və qrup metadata sorğuları

`9cd1e8e8` — `src/api/integrations/storage/s3/libs/minio.server.ts`

Uğursuz media yükləmələri təkrar cəhd edir; qrup metadata yeniləməsi isə
geri-çəkilmə (backoff) ilə işləyir ki, çoxlu qrupda WhatsApp limitinə dəyməsin.

## 4. Media mərhələsi webhook-u saxlamır

`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` —
`uploadReceivedMediaWithDeadline` / `uploadReceivedMedia`

`messages.upsert` mediasını S3-ə yükləyir və webhook-u yalnız bu iş bitəndən
sonra göndərirdi. 2026-09-13-də satıcıların öz telefonundan göndərdiyi media
(fromMe) əksər hallarda `mediaUrl` almırdı (bir instansda restartdan bəri 74-dən
68-i). Bu hallarda handler bazaya yazma ilə webhook arasında heç nə loglamadan
dayanırdı: Katibe mesajı yalnız sonrakı trafiklə və ya 5 dəqiqəlik cron ilə
görürdü. Harada dayandığı hələ bilinmir.

İndi media mərhələsinin vaxt həddi var: `S3_MEDIA_STAGE_TIMEOUT_MS`, default
60 000. Vaxt keçəndə webhook `mediaUrl`-siz gedir, jurnala isə WARN yazılır:
`Media upload still pending after …ms at stage "download|upload|db"`. İş sonradan
bitərsə, «finished late» qeydi düşür. Upstream-dəki iki `return` (video
söndürülüb, mesajda media yoxdur) bütün handler-dən çıxırdı. Bu da webhook-u və
dəstədəki qalan mesajları buraxırdı. İndi onlar yalnız bu metoddan çıxır.

`getBase64FromMediaMessage`-də Baileys-ə verilən logger səviyyəsi `info`-dur,
ona görə «sending reupload media request…» görünür. Bu gözləmənin öz vaxt həddi
yoxdur.

## Nginx qapısı (repodan kənar, `/etc/nginx`)

`evolution.katibe.online` vhost-u Evolution-un açar modelindəki boşluğu bağlayır:
[auth.guard.ts](src/api/guards/auth.guard.ts) açarı «oxu/yaz» deyə bölmür, ona
görə kənar tətbiqi `markMessageAsRead`-dən saxlayan yeganə şey nginx-dir.

Blanket qadağalar (hamıya): `^/message/send`, `^/chat/(markMessageAsRead|sendPresence)`,
`^/group/`. Üstündən yalnız dəqiq (`=`) uyğunluqla deşik açılır:

| endpoint | kim | qoruma |
|---|---|---|
| `/chat/getBase64FromMediaMessage/principal` | 165.232.72.187 | `satisfy any` — IP **və ya** parol |
| `/message/sendText/principal` | 165.232.72.187 | IP **və** parol, `evosend` limiti (12/dəq), `/var/log/nginx/evo-send.log` |

Dəqiq uyğunluq regex-dən güclü olduğu üçün `sendMedia`, `sendAudio` və digər
xətlər (`Zemfira`, `Rouz-*`) 403 qalır. Yoxlanıb (2026-09-27): siyahıda olmayan
IP-dən `sendText` 403, siyahıdakı IP üçün parol qapısına çatır, `sendMedia` isə
hər halda 403.

---

## `.env` sahibliyi — xidmət onu OXUYA BİLMƏLİDİR

Xidmət `evolution` istifadəçisi altında işləyir (`systemctl cat evolution-api`),
`.env` isə `600`-dür. Faylı `root` altında `cp`/`mv` ilə əvəz etmək sahibliyi
`root`-a keçirir və xidmət onu oxuya bilmir: Prisma
`DATABASE_CONNECTION_URI`-ni tapmır, proses qalxmır, systemd isə sonsuz
yenidən başlatmağa girir.

2026-09-29-da məhz belə oldu: `LOG_BAILEYS` müvəqqəti dəyişdirilib
`mv .env.bak .env` ilə geri qaytarıldı və dörd nömrə **14 dəqiqə** (04:53–05:07
UTC) qopdu. Mesaj itmədi — WhatsApp növbəyə yığıb qoşulandan sonra çatdırdı —
amma panel həmin müddətdə kor idi.

Qayda: `.env`-ə toxunandan sonra HƏMİŞƏ
`chown evolution:evolution .env && chmod 600 .env`. Redaktə üçün `mv` yox,
`sed -i` işlət — o, sahibliyi saxlayır.

---

## Arxiv bayrağı (`Chat.archived`)

Baileys arxivlənmiş söhbəti `chats.update` hadisəsində onsuz da göndərir
(`{ id, archived }` — app-state sinxronizasiyası, `Utils/chat-utils.ts`
`archiveChatAction`). Evolution isə `Chat` cədvəlində yalnız
`remoteJid`/`name`/`unreadMessages` saxlayır, qalanını atırdı.

Nəticə kənar tətbiqdə görünürdü: katibe.online söhbət siyahısında sahibin
telefonda arxivlədiyi yüzlərlə qrup adi söhbət kimi dururdu və ekran
WhatsApp Desktop-dakından tamam fərqli idi.

Dəyişən üç yer:

- `prisma/*-schema.prisma` — `Chat.archived Boolean @default(false)`;
- `prisma/*-migrations/20260928190000_add_chat_archived/` — sütun;
- `whatsapp.baileys.service.ts`:
  - `chats.upsert` — yeni söhbət yaradılanda `archived` da yazılır;
  - `chats.update` — `archived` gələndə UPSERT olunur. Update yox, upsert:
    mesajı olan söhbətlərin bir hissəsinin `Chat` sətri ümumiyyətlə yoxdur
    və məhz arxivlənmişlər belədir.

**Köhnə arxivlər geri gəlmir.** Baileys app-state-i artımla sinxronlaşdırır:
saxlanılan versiyadan sonrakı patch-ləri alır. Bu günə qədər arxivlənmiş
söhbətlərin patch-i çoxdan tətbiq olunub (və Evolution onu atıb), yəni
yenidən başlatmaq onları gətirmir. Bundan SONRA telefonda arxivlənən hər
söhbət düşür. Tam siyahı üçün `app-state-sync-version-*` açarlarını
Redis-dən silmək (sessiyanın özünə toxunmadan) və yenidən qoşulmaq lazımdır
— bu, ayrıca qərardır.

---

## Köməkçi skriptlər

### `scripts/send-message.sh`

Əl ilə mesaj göndərmə yoxlaması (upstream koduna toxunmur). Açarı `.env`-dən
özü oxuyur, terminala çap etmir; `--dry` ilə yalnız payload-u göstərir.

```bash
scripts/send-message.sh principal 994XXXXXXXXX "salam" --dry
```

`delay`/`presence` qəsdən verilmir — qarşı tərəf «yazır...» görmür və söhbət
oxunmuş işarələnmir (oxunmuş işarəsi yalnız instance ayarındakı
`readMessages`/`readStatus` `true` olanda baş verir, hər 4 instance-da `false`).

---

## Klonlayarkən

Repoda `evolution-manager-v2` submodulu var (idarəetmə paneli, ayrıca açıq
repodur) və bu maşında **yüklənməyib** — API onsuz tam işləyir. Lazım olsa:

```bash
git submodule update --init --recursive
```

Lazım deyilsə heç nə etməyin; `npm install` və `npm run build` submoduldan asılı
deyil.

---

## Upstream ilə sinxron qalmaq

```bash
git remote add upstream https://github.com/EvolutionAPI/evolution-api.git
git fetch upstream
git rebase upstream/main        # və ya merge
```

Yuxarıdakı dəyişikliklər iki fayla toxunur, ona görə münaqişə çıxsa demək olar
həmişə `whatsapp.baileys.service.ts`-də olacaq.
