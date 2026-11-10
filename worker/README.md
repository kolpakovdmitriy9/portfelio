# Прокси «дизайнера» (Cloudflare Worker)

Сайт статический, ключи нельзя класть в `index.html`. Воркер отдаёт сайту только короткий JSON `{reply, action}`.

## Бесплатный вариант (рекомендуется): Cloudflare Workers AI — ключ и карта не нужны
1. Бесплатный аккаунт на cloudflare.com, `npm i -g wrangler && wrangler login`
2. В папке `worker/` создать `wrangler.toml`:
   ```
   name = "designer-proxy"
   main = "designer-proxy.js"
   compatibility_date = "2024-11-01"
   [ai]
   binding = "AI"
   [vars]
   ALLOWED_ORIGIN = "https://kolpakovdmitriy9.github.io"
   ```
3. `wrangler deploy` → URL вида `https://designer-proxy.<имя>.workers.dev`
4. В `index.html` задать `window.EXP_DESIGNER_API = "<этот URL>"`.

Модель по умолчанию `@cf/meta/llama-3.1-8b-instruct` (меняется переменной `CF_MODEL`). Лимиты бесплатного плана смотри в тарифах Cloudflare.

## Платный вариант: Anthropic
Убрать блок `[ai]` из `wrangler.toml` и выполнить `wrangler secret put ANTHROPIC_API_KEY`.

Пока URL пуст, сценка работает на заготовленных репликах. Лимиты: 20 запросов/мин с IP на воркере и 12 вызовов на загрузку страницы на клиенте.
