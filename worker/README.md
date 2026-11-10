# Прокси «дизайнера» (Cloudflare Worker)

Сайт статический, ключ Anthropic нельзя класть в `index.html`. Воркер держит ключ в секретах и отдаёт сайту только
короткий JSON `{reply, action}`.

1. `npm i -g wrangler && wrangler login`
2. `wrangler init designer-proxy` → положить `designer-proxy.js` как точку входа
3. `wrangler secret put ANTHROPIC_API_KEY`
4. В `wrangler.toml`: `[vars] ALLOWED_ORIGIN = "https://kolpakovdmitriy9.github.io"`
5. `wrangler deploy` → получишь URL вида `https://designer-proxy.<имя>.workers.dev`
6. В `index.html` задать `window.EXP_DESIGNER_API = "<этот URL>"` (строка с `EXP_DESIGNER_API`).

Пока URL пуст, сценка работает на заготовленных репликах. Лимиты: 20 запросов/мин с IP на воркере и 12 вызовов на загрузку страницы на клиенте.
