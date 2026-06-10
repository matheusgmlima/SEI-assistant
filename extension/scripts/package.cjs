/**
 * Empacota a extensão num .zip pronto para distribuição (modo desenvolvedor).
 * Inclui apenas o necessário: manifest.json + pasta dist/.
 * O nome do arquivo usa a versão do manifest automaticamente.
 *
 * Uso: npm run package   (roda o build antes, via package.json)
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const distPath = path.join(root, "dist");

if (!fs.existsSync(distPath)) {
  console.error("✗ Pasta dist/ não encontrada. Rode 'npm run build' primeiro.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = manifest.version || "0.0.0";
const downloads = path.join(os.homedir(), "Downloads");
const outDir = fs.existsSync(downloads) ? downloads : root;
const outPath = path.join(outDir, `SEI-Assistant-v${version}.zip`);

const zip = new JSZip();
zip.file("manifest.json", fs.readFileSync(manifestPath));

let count = 1;
function addDir(absDir, folder) {
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    if (fs.statSync(abs).isDirectory()) addDir(abs, folder.folder(name));
    else { folder.file(name, fs.readFileSync(abs)); count++; }
  }
}
addDir(distPath, zip.folder("dist"));

zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } })
  .then((buf) => {
    fs.writeFileSync(outPath, buf);
    const kb = Math.round(buf.length / 1024);
    console.log(`\n✓ ZIP gerado: ${outPath}`);
    console.log(`  versão ${version} · ${count} arquivos · ${kb} KB`);
    console.log(`  Pronto para subir no Drive / instalar em modo desenvolvedor.`);
  })
  .catch((e) => { console.error("✗ Falha ao gerar o ZIP:", e); process.exit(1); });
