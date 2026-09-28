-- LOKAL MİQRASİYA (upstream-də yoxdur).
--
-- Telefonda arxivlənmiş söhbət. Baileys bunu `chats.update` hadisəsində
-- onsuz da göndərir (app-state sinxronizasiyası), Evolution isə saxlamırdı —
-- nəticədə kənar tətbiq (katibe.online) yüzlərlə arxivlənmiş qrupu adi
-- söhbət kimi göstərirdi və ekran WhatsApp-dakından tamam fərqli görünürdü.
ALTER TABLE "Chat" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
