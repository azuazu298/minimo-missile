# minimo-missile

合言葉でマッチングする対戦ゲーム。

## 構成
- `server/` … 合言葉マッチング＆状態中継用のWebSocketサーバー（Node.js）
- `docs/` … ブラウザで動くクライアント（GitHub Pagesで公開）

## ローカルで動かす
```bash
cd server
npm install
npm start
# => minimo-missile server listening on 8787
```
`docs/index.html` をブラウザで2つ開き（別タブでOK）、同じ合言葉で接続すると、
矢印キーで動かした丸がお互いの画面に反映されます。

## 本番デプロイ
1. このリポジトリをGitHubにpush
2. Renderで `server/` をWebサービスとしてデプロイ
3. 発行されたURL（`https://xxxx.onrender.com`）を `wss://xxxx.onrender.com` にして
   `docs/index.html` の `SERVER_URL` を書き換えてpush
4. GitHubのSettings → Pages で、Source: Deploy from a branch、Branch: main /docs を選択
