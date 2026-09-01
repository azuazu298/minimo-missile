import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pagesはリポジトリ名のサブパス（/minimo-missile/）で公開されるため必須。
  // リポジトリ名を変えた場合はここも合わせて変更してください。
  base: "/minimo-missile/",
  build: {
    outDir: "../docs",
    emptyOutDir: true,
  },
});
