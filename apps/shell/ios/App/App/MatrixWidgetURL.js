// JavaScriptCore has no browser URL. Foundation resolves URLs; this small
// URLSearchParams implementation supplies the subset used by our connectors.
class URLSearchParams {
    constructor(value = '', changed = () => {}) {
        const decode = s => decodeURIComponent(s.replace(/\+/g, ' '));
        this.rows = String(value).replace(/^\?/, '').split('&').filter(Boolean).map(row => {
            const at = row.indexOf('=');
            return at < 0 ? [decode(row), ''] : [decode(row.slice(0, at)), decode(row.slice(at + 1))];
        });
        this.changed = changed;
    }
    get(key) { return this.rows.find(row => row[0] === key)?.[1] ?? null; }
    has(key) { return this.rows.some(row => row[0] === key); }
    set(key, value) {
        const index = this.rows.findIndex(row => row[0] === key);
        this.rows = this.rows.filter((row, i) => row[0] !== key || i === index);
        if (index < 0) this.rows.push([key, String(value)]); else this.rows[index][1] = String(value);
        this.changed(this.toString());
    }
    delete(key) { this.rows = this.rows.filter(row => row[0] !== key); this.changed(this.toString()); }
    sort() { this.rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this.changed(this.toString()); }
    toString() {
        const encode = s => encodeURIComponent(s).replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
        return this.rows.map(row => row.map(encode).join('=')).join('&');
    }
}
class URL {
    constructor(raw, base) {
        this._parts = JSON.parse(_matrixURL(String(raw), base == null ? '' : String(base)));
        if (this._parts.error) throw new TypeError('Invalid URL');
        this.searchParams = new URLSearchParams(this._parts.search, query => { this._parts.search = query ? '?' + query : ''; });
    }
    get protocol() { return this._parts.protocol; }
    get hostname() { return this._parts.hostname; }
    get origin() { return this._parts.origin; }
    get username() { return this._parts.username; }
    get password() { return this._parts.password; }
    get pathname() { return this._parts.pathname; }
    get hash() { return this._parts.hash; }
    set hash(value) { this._parts.hash = value ? '#' + String(value).replace(/^#/, '') : ''; }
    get search() { return this._parts.search; }
    set search(value) {
        this._parts.search = value ? '?' + String(value).replace(/^\?/, '') : '';
        this.searchParams = new URLSearchParams(this._parts.search, query => { this._parts.search = query ? '?' + query : ''; });
    }
    get href() { return this._parts.authority + this.pathname + this.search + this.hash; }
    toString() { return this.href; }
}
