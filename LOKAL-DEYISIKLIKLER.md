# Bu fork upstream-dən nə ilə fərqlənir

Bu repo [Evolution API](https://github.com/EvolutionAPI/evolution-api)-nin
forkudur. Yuxarı axından (upstream) fərqi **4 commit**-dir; hamısı canlı
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

---

## Upstream ilə sinxron qalmaq

```bash
git remote add upstream https://github.com/EvolutionAPI/evolution-api.git
git fetch upstream
git rebase upstream/main        # və ya merge
```

Yuxarıdakı dəyişikliklər iki fayla toxunur, ona görə münaqişə çıxsa demək olar
həmişə `whatsapp.baileys.service.ts`-də olacaq.
