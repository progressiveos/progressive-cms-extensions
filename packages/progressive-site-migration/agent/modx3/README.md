# MODX migration agent (pcms-agent.php)

Агент для сайта-источника на MODX 3.0/3.2: один PHP-файл в web-корне, который
выдаёт PCMS всё нужное для переноса в нашем формате — ресурсы с TV (значения
MIGX проходят насквозь, сырым JSON), медиа-источники и файлы, content types,
детект дополнений (MIGX / Gallery / SEO Suite) и история редиректов SEO Suite.
Бутстрапит настоящий modX API — **доступ к базе со стороны PCMS не нужен
вообще**, агент — это «наш человек внутри MODX». Только чтение.

## Установка на MODX-сайте

1. Скопируй `pcms-agent.php` в web-корень MODX (рядом с `index.php`).
2. В файле замени `PCMS_AGENT_TOKEN` на длинную случайную строку.
3. (Опционально) впиши IP нового сервера в `PCMS_AGENT_ALLOWED_IPS`.
4. Только HTTPS. Удали файл после завершения миграции.

## Использование со стороны PCMS

```
PCMS_MIGRATE_TOKEN=<тот-же-токен> \
cms migrate modx3 --endpoint https://old-site.example/pcms-agent.php \
  --out-dir ./migration-out
```

Одна команда строит всё:

- `redirects.csv` — URL-план: удалённые → 410, переименованные (по
  `--map`/истории SEO Suite) → 301; `cms redirects validate` → `apply`;
- `canonical.csv` — план «старый URL = канонический путь» (§61);
- `bundle/` — готовый `.pcpub`-воркспейс: `content/*.pcmd` (route.path =
  старый URI, контент HTML → markdown через turndown, картинки вынесены в
  image-блоки с `bundle:assets/...`), `assets/` (скачанные картинки),
  `publication.yaml`;
- `migx.json` — сырые MIGX-TV по ресурсам (фаза 2: маппинг в блоки);
- `summary.json` — сводка + готовые next-step команды
  (`cms redirects ...`, `cms bundle validate|pack|submit`).

Альтернатива live-выкачиванию: сохрани экспорт агента и скорми файлом —
`--export export.json` (формат: info/tvs/resources/seosuiteRedirects).

## Честные границы v1

- Контент переносится как **rich_text-passthrough** (HTML → markdown):
  сайт сразу живёт на новом движке с сохранёнными URL. Тонкая вёрстка
  MIGX-страниц рендерится шаблонами MODX и в БД не лежит — для них есть
  `migx.json` (маппинг в PCMS-блоки = фаза 2, по ресурсам, руками/агентом).
- Картинки из контента выгружаются в bundle assets отдельными image-блоками
  (после текста), не в исходных позициях; дедуп по sha256 у движка.
- Ресурсы-ссылки (modWebLink/modSymLink) и не-web контексты не переносятся;
  нестандартные class_key пропускаются с предупреждением.

## Безопасность агента

- Токен обязателен (header `X-PCMS-Agent-Token`, `hash_equals`).
- Опциональный IP-allowlist. Только GET, только чтение, без eval/SQL-строк
  (все запросы через prepared statements / xPDO API).
- Агент отдаёт контент сайта — держи эндпоинт в секрете и удали после
  миграции.
