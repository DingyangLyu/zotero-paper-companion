/* Development builds only (npm run build:dev) — never shipped in the release XPI.
 * POST /paper-companion-dev/eval with header X-PC-Token runs the body as an
 * async function inside the plugin scope, so the real Zotero UI can be
 * checked from a terminal. The token is regenerated at every startup and
 * written to <Zotero data dir>/paper-companion/.devbridge-token (mode 600). */
var PCDevBridge = (function () {
  const PATH = '/paper-companion-dev/eval';
  const token = Services.uuid.generateUUID().toString().replace(/[{}-]/g, '');
  const tokenFile = PathUtils.join(Zotero.DataDirectory.dir, 'paper-companion', '.devbridge-token');
  const scope = globalThis;
  function Endpoint() {}
  Endpoint.prototype = {
    supportedMethods: ['POST'],
    supportedDataTypes: '*',
    async init({headers, data}) {
      if (headers['x-pc-token'] !== token) return [403, 'text/plain', 'forbidden\n'];
      try {
        const AsyncFunction = (async () => {}).constructor;
        const result = await new AsyncFunction('scope', String(data || ''))(scope);
        return [200, 'application/json', JSON.stringify({ok: true, result: result === undefined ? null : result})];
      } catch (e) {
        return [200, 'application/json', JSON.stringify({ok: false, error: String(e), stack: String(e?.stack || '')})];
      }
    },
  };
  Zotero.Server.Endpoints[PATH] = Endpoint;
  IOUtils.makeDirectory(PathUtils.parent(tokenFile), {ignoreExisting: true, createAncestors: true})
    .then(() => IOUtils.writeUTF8(tokenFile, token))
    .then(() => IOUtils.setPermissions(tokenFile, 0o600))
    .catch(e => Zotero.logError(e));
  return {
    stop() {
      if (Zotero.Server.Endpoints[PATH] === Endpoint) delete Zotero.Server.Endpoints[PATH];
      IOUtils.remove(tokenFile, {ignoreAbsent: true}).catch(() => {});
    },
  };
})();
