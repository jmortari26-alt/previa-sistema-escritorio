// Prévia reservada: este service worker decifra o site no próprio aparelho, arquivo por arquivo, bloco a bloco.
var MANIFESTO = "m-53ae8ab5138493de.bin", BLOCO = 262144;
var BASE = new URL("./", self.location.href).pathname, SITE = BASE + "s/", BANCO = "previa" + BASE;
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
var pronto = null;
self.addEventListener("message", function (e) { if (e.data === "nova-chave") { pronto = null; } });
function hex(h) { return new Uint8Array(h.match(/../g).map(function (x) { return parseInt(x, 16); })); }
function vetor(v, i) { var x = new Uint8Array(12); x.set(v, 0); new DataView(x.buffer).setUint32(8, i); return x; }
function lerChave() {
  return new Promise(function (ok, falha) {
    var r = indexedDB.open(BANCO, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("k"); };
    r.onerror = function () { falha(r.error); };
    r.onsuccess = function () {
      var t = r.result.transaction("k", "readonly").objectStore("k").get("chave");
      t.onsuccess = function () { ok(t.result || null); }; t.onerror = function () { falha(t.error); };
    };
  });
}
function preparar() {
  if (!pronto) {
    pronto = (async function () {
      var bruta = await lerChave();
      if (!bruta) { throw new Error("sem chave"); }
      var chave = await crypto.subtle.importKey("raw", bruta, "AES-GCM", false, ["decrypt"]);
      var r = await fetch(BASE + MANIFESTO);
      if (!r.ok) { throw new Error("rede"); }
      var b = new Uint8Array(await r.arrayBuffer()), v = b.subarray(0, 8), cif = b.subarray(8), C = BLOCO + 16, partes = [];
      for (var i = 0; i * C < cif.length; i++) {
        partes.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: vetor(v, i) }, chave, cif.subarray(i * C, Math.min(cif.length, (i + 1) * C)))));
      }
      var junto = new Uint8Array(partes.reduce(function (s, p) { return s + p.length; }, 0)), pos = 0;
      partes.forEach(function (p) { junto.set(p, pos); pos += p.length; });
      return { chave: chave, mapa: JSON.parse(new TextDecoder().decode(junto)) };
    })();
    pronto.catch(function () { pronto = null; });
  }
  return pronto;
}
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf(SITE) !== 0 || e.request.method !== "GET") { return; }
  e.respondWith(servir(e.request, u));
});
async function servir(req, u) {
  var rel = decodeURIComponent(u.pathname.slice(SITE.length));
  if (rel === "" || /\/$/.test(rel)) { rel += "index.html"; }
  var x;
  try { x = await preparar(); } catch (erro) {
    if (req.mode === "navigate") { return Response.redirect(BASE + "?volta=" + encodeURIComponent(rel), 302); }
    return new Response("", { status: 403 });
  }
  var a = x.mapa[rel];
  if (!a) { return new Response("Página não encontrada nesta prévia.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
  try { return await responder(req, x.chave, a); } catch (erro) { return new Response("", { status: 502 }); }
}
async function responder(req, chave, a) {
  var nome = a[0], tipo = a[1], n = a[2], v = hex(a[3]);
  var cab = new Headers({ "Content-Type": tipo, "Accept-Ranges": "bytes" });
  if (n === 0) { cab.set("Content-Length", "0"); return new Response(null, { status: 200, headers: cab }); }
  var ini = 0, fim = n - 1, parcial = false, r = req.headers.get("range");
  var m = r && /^bytes=(\d*)-(\d*)$/.exec(r.trim());
  if (m && (m[1] !== "" || m[2] !== "")) {
    if (m[1] === "") { ini = Math.max(0, n - Number(m[2])); } else { ini = Number(m[1]); if (m[2] !== "") { fim = Math.min(n - 1, Number(m[2])); } }
    if (ini >= n || ini > fim) { return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + n } }); }
    parcial = true;
  }
  // só os blocos que cobrem o trecho pedido
  var C = BLOCO + 16, b0 = Math.floor(ini / BLOCO), b1 = Math.floor(fim / BLOCO), total = n + 16 * Math.ceil(n / BLOCO);
  var de = b0 * C, ate = Math.min((b1 + 1) * C, total) - 1;
  // pedido em pedaços fora do cache do navegador (16/11): no GitHub, o Chrome juntava pedaços guardados e depois entregava o
  // arquivo inteiro cortado (2.292.591 bytes anunciados, 786.480 entregues), e o vídeo parava com "Failed to fetch"
  var resp = await fetch(BASE + nome, (de > 0 || ate < total - 1) ? { headers: { Range: "bytes=" + de + "-" + ate }, cache: "no-store" } : {});
  if (!resp.ok) { throw new Error("http " + resp.status); }
  var pular = resp.status === 206 ? 0 : de, leitor = resp.body.getReader(), bloco = b0, guarda = new Uint8Array(0);
  function tamanho(i) { return Math.min(BLOCO, n - i * BLOCO) + 16; }
  var corpo = new ReadableStream({
    pull: async function (ctl) {
      try {
        for (;;) {
          if (bloco > b1) { leitor.cancel().catch(function () {}); ctl.close(); return; }
          var t = tamanho(bloco);
          if (guarda.length >= t) {
            var claro = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: vetor(v, bloco) }, chave, guarda.subarray(0, t)));
            guarda = guarda.slice(t);
            var p0 = bloco * BLOCO, a0 = Math.max(ini - p0, 0), a1 = Math.min(fim - p0 + 1, claro.length);
            bloco++;
            ctl.enqueue(claro.subarray(a0, a1));
            return;
          }
          var lido = await leitor.read();
          if (lido.done) { throw new Error("arquivo incompleto"); }
          var pedaco = lido.value;
          if (pular) { var k = Math.min(pular, pedaco.length); pedaco = pedaco.subarray(k); pular -= k; }
          if (pedaco.length) { var j = new Uint8Array(guarda.length + pedaco.length); j.set(guarda); j.set(pedaco, guarda.length); guarda = j; }
        }
      } catch (erro) { ctl.error(erro); }
    },
    cancel: function () { leitor.cancel().catch(function () {}); }
  });
  cab.set("Content-Length", String(fim - ini + 1));
  if (parcial) { cab.set("Content-Range", "bytes " + ini + "-" + fim + "/" + n); }
  return new Response(corpo, { status: parcial ? 206 : 200, headers: cab });
}
