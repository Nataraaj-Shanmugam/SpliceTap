/**
 * SpliceTap Requestly Importer
 * B2-F6: converts a Requestly rules export into SpliceTap rules (UMD).
 * Loads as: (a) a plain script in the popup, (b) a CommonJS module under Jest.
 *
 * The file Requestly exports is a flat JSON array of records. A record is a
 * rule (objectType "rule", with a ruleType, a status and `pairs`) or a group
 * (objectType "group"). Each pair carries a `source` (key Url|host|path,
 * operator Equals|Contains|Matches|Wildcard_Matches, value, optional
 * `filters`) and the settings for that rule type. This was read from
 * github.com/requestly/interceptor: shared/src/types/entities/rules/rule.ts,
 * app/.../ImportRulesModal/actions, SharingModal/actions (the exporter) and
 * browser-extension/mv3/src/common/ruleMatcher.ts (what the operators mean).
 *
 * Principle: never silently change what a rule does. A pair that cannot be
 * represented faithfully is SKIPPED with a reason; one that can be represented
 * with a difference is converted with a WARNING. Every pair becomes its own
 * SpliceTap rule (SpliceTap rules have one URL condition).
 *
 *   convert(json[, options]) -> { rules, skipped: [{name, reason}], warnings: [{name, message}] }
 *   options.appendResponseAdd  Requestly's response-header "Add" appends to an
 *                              existing header; true (default) maps it to op
 *                              'append', false to 'set' with a warning.
 *   options.validate           run the shared schema over every result (default
 *                              true) and skip what it refuses, with its reason.
 */
(function (global) {
    'use strict';

    const DEFAULTS = { appendResponseAdd: true, validate: true };
    const FILE_LABEL = 'Requestly file';
    const SUPPORTED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const DYNAMIC_ORIGIN = 'rq_request_initiator_origin()';

    // Requestly's resource-type names (Chrome's) -> SpliceTap's.
    const RESOURCE_TYPES = new Map([
        ['xmlhttprequest', 'fetch-xhr'], ['xhr', 'fetch-xhr'], ['fetch', 'fetch-xhr'],
        ['main_frame', 'document'], ['sub_frame', 'subdocument'],
        ['script', 'script'], ['stylesheet', 'stylesheet'], ['image', 'image'],
        ['font', 'font'], ['media', 'media'], ['websocket', 'websocket'],
        ['ping', 'ping'], ['other', 'other'], ['object', 'other'], ['csp_report', 'other']
    ]);

    // Request headers Requestly appends to rather than sets (parseHeadersRule).
    const APPEND_SUPPORTED_REQUEST_HEADERS = [
        'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers',
        'cache-control', 'connection', 'content-language', 'cookie', 'forwarded', 'if-match',
        'if-none-match', 'keep-alive', 'range', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        'via', 'want-digest', 'x-forwarded-for'
    ];

    const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
    // Lookarounds and backreferences: fine in the page, refused by Chrome's RE2.
    const NOT_RE2_RE = /\(\?(?:=|!|<=|<!)|\\[1-9]|\\k</;
    // Characters Requestly's wildcard builder leaves active as regex syntax.
    const WILDCARD_REGEX_CHARS_RE = /[+()[\]{}|^$\\]/;

    // C0/C1 controls and the Unicode line/paragraph separators (U+2028, U+2029).
    const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const text = (v) => (typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v)));
    const unique = (list) => list.filter((v, i) => list.indexOf(v) === i);

    function dep(globalName, modulePath) {
        if (global[globalName]) return global[globalName];
        try {
            return typeof require === 'function' ? require(modulePath) : null;
        } catch (e) {
            return null;
        }
    }
    const getSchema = () => dep('SpliceTapRuleSchema', '../rule-schema.js');
    function nameMax() {
        const common = dep('SpliceTapCommon', '../common.js');
        return (common && common.LIMITS && common.LIMITS.NAME_MAX) || 100;
    }
    function statusRange() {
        const schema = getSchema();
        const limits = (schema && schema.LIMITS) || {};
        return { min: limits.STATUS_MIN || 200, max: limits.STATUS_MAX || 599 };
    }
    function delayRange() {
        const schema = getSchema();
        const limits = (schema && schema.LIMITS) || {};
        return { min: limits.DELAY_MS_MIN || 1, max: limits.DELAY_MS_MAX || 30000 };
    }

    const usedIds = new Set();
    function freshId() {
        const common = dep('SpliceTapCommon', '../common.js');
        for (;;) {
            const id = common && common.generateId
                ? common.generateId('rule')
                : `rule_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            if (!usedIds.has(id)) {
                usedIds.add(id);
                return id;
            }
        }
    }

    // ------------------------------------------------------------- names

    function truncate(s, max) {
        if (s.length <= max) return s;
        let cut = max - 1;
        const code = s.charCodeAt(cut - 1);
        if (code >= 0xD800 && code <= 0xDBFF) cut -= 1; // never split a surrogate pair
        return s.slice(0, cut) + '…';
    }
    function cleanName(raw, fallback) {
        const s = text(raw).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
        return s || fallback;
    }
    const fitName = (base, suffix) => truncate(base, nameMax() - suffix.length) + suffix;
    const shorten = (s, n) => truncate(s, n || 60);

    // ------------------------------------------------------------- records

    function recordsOf(json) {
        let data = json;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return null;
            }
        }
        if (Array.isArray(data)) return data;
        if (isObj(data)) {
            if (Array.isArray(data.rules)) {
                const groups = Array.isArray(data.groups) ? data.groups
                    : (Array.isArray(data.updatedGroups) ? data.updatedGroups : []);
                return data.rules.concat(groups);
            }
            if (data.objectType === 'rule' || data.objectType === 'group') return [data];
        }
        return null;
    }

    function kindOf(r) {
        if (!isObj(r)) return null;
        if (r.objectType === 'group') return 'group';
        if (r.objectType === 'rule') return 'rule';
        if (r.objectType === undefined && typeof r.ruleType === 'string' && Array.isArray(r.pairs)) return 'rule';
        return null;
    }

    function detect(json) {
        const records = recordsOf(json);
        if (!records) return false;
        return records.some((r) => {
            const kind = kindOf(r);
            if (kind === 'rule') return typeof r.ruleType === 'string';
            if (kind === 'group') return typeof r.name === 'string';
            return false;
        });
    }

    // ------------------------------------------------------------- regex helpers

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

    function parseRegexValue(value) {
        const m = /^\/([\s\S]*)\/([dgimsuy]*)$/.exec(value);
        if (m) return m[1] === '' ? null : { body: m[1], flags: m[2] };
        // Requestly's in-page matcher treats the enclosing slashes as optional.
        if (value.charAt(0) === '/') return null;
        return { body: value, flags: '' };
    }

    function groupCount(body) {
        try {
            return new RegExp(body + '|').exec('').length - 1;
        } catch (e) {
            return 0;
        }
    }

    function hasTopLevelAlternation(body) {
        let depth = 0;
        let inClass = false;
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '\\') { i++; continue; }
            if (inClass) { if (c === ']') inClass = false; continue; }
            if (c === '[') inClass = true;
            else if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === '|' && depth === 0) return true;
        }
        return false;
    }

    function endsWithUnescapedDollar(body) {
        if (body.charAt(body.length - 1) !== '$') return false;
        let slashes = 0;
        for (let i = body.length - 2; i >= 0 && body[i] === '\\'; i--) slashes++;
        return slashes % 2 === 0;
    }

    // Every unescaped `.` outside a character class becomes `replacement`.
    function replaceDots(body, replacement) {
        let out = '';
        let inClass = false;
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '\\') { out += c + (body[i + 1] || ''); i++; continue; }
            if (inClass) { if (c === ']') inClass = false; out += c; continue; }
            if (c === '[') inClass = true;
            out += c === '.' && !inClass ? replacement : c;
        }
        return out;
    }

    // A regex written for just the host or just the path, made to work on the
    // whole URL. No lookarounds, so Chrome's RE2 accepts it too.
    function embedComponentRegex(body, kind) {
        const left = body.charAt(0) === '^';
        const right = endsWithUnescapedDollar(body);
        if ((left || right) && hasTopLevelAlternation(body)) return null;
        let inner = body;
        if (left) inner = inner.slice(1);
        if (right) inner = inner.slice(0, -1);
        if (inner === '') return null;
        if (kind === 'host') {
            inner = replaceDots(inner, '[^\\/?#]');
            return '^https?:\\/\\/' + (left ? '' : '[^\\/?#]*?') + '(?:' + inner + ')' + (right ? '(?:[\\/?#]|$)' : '');
        }
        inner = replaceDots(inner, '[^?#]');
        return '^https?:\\/\\/[^\\/?#]*' + (left ? '' : '[^?#]*?') + '(?:' + inner + ')' + (right ? '(?:[?#]|$)' : '');
    }

    // ------------------------------------------------------------- URL condition

    function normalizeKey(k) {
        const s = text(k).toLowerCase();
        return s === 'url' || s === 'host' || s === 'path' ? s : null;
    }
    function normalizeOperator(o) {
        const s = text(o).toLowerCase();
        if (s === 'equals' || s === 'contains' || s === 'matches') return s;
        if (s === 'wildcard_matches' || s === 'wildcard') return 'wildcard';
        return null;
    }

    const regexPattern = (body, groups) => ({ pattern: '/' + body + '/', groups: groups || 0 });

    // Case: SpliceTap matches URLs case-insensitively, Requestly's operators
    // are case-sensitive. That is a documented, global difference; warning on
    // every mixed-case id in a URL would bury the warnings that matter.

    function userRegexPattern(value, kind, opts, notes) {
        const parsed = parseRegexValue(value);
        if (!parsed) return { skip: `The regular expression "${shorten(value)}" is not written as /pattern/.` };
        try {
            new RegExp(parsed.body);
        } catch (e) {
            return { skip: `The regular expression "${shorten(value)}" is not valid.` };
        }
        if (opts.network && NOT_RE2_RE.test(parsed.body)) {
            return { skip: 'The regular expression uses a lookahead, lookbehind or backreference, which Chrome\'s network layer cannot evaluate, and this rule is applied there.' };
        }
        if (parsed.flags) {
            notes.push(`Regex flags "${parsed.flags}" were dropped: SpliceTap matches case-insensitively and has no flags.`);
        }
        let body = parsed.body;
        if (kind !== 'url') {
            body = embedComponentRegex(parsed.body, kind);
            if (!body) return { skip: `The ${kind} regular expression mixes anchors with alternatives, which cannot be moved onto the whole URL.` };
            notes.push(`The ${kind} pattern was rewritten to look only at the URL's ${kind}; check it still matches what you expect.`);
        }
        return regexPattern(body, groupCount(parsed.body));
    }

    function wildcardPattern(value, kind, opts, notes) {
        const special = WILDCARD_REGEX_CHARS_RE.test(value);
        if (special) {
            notes.push('The wildcard contains regex characters; Requestly evaluates them as a regular expression, and so does this import.');
        }
        if (kind === 'url') {
            // $1-$9 in a redirect destination only work with a /regex/ pattern.
            const native = value.includes('*') && !special && !opts.needsRegex && !(value.startsWith('/') && value.endsWith('/'));
            if (native) return { pattern: value, groups: 0 };
            const body = value.replace(/([?.-])/g, '\\$1').replace(/\*/g, '(.*)');
            return regexPattern('^' + body + '$', (value.match(/\*/g) || []).length);
        }
        if (kind === 'path' && !/^[/*]/.test(value)) {
            return { skip: 'A path condition has to start with "/" (or a wildcard); Requestly would never match this one.' };
        }
        const star = kind === 'host' ? '([^\\/?#]*)' : '([^?#]*)';
        const body = value.replace(/([?.-])/g, '\\$1').replace(/\*/g, star);
        const groups = (value.match(/\*/g) || []).length;
        return regexPattern(kind === 'host'
            ? '^https?:\\/\\/' + body + '(?:[\\/?#]|$)'
            : '^https?:\\/\\/[^\\/?#]*' + body + '(?:[?#]|$)', groups);
    }

    function conditionPattern(source, opts, notes) {
        const key = normalizeKey(source.key);
        const op = normalizeOperator(source.operator);
        if (!key) return { skip: `Unsupported condition key "${shorten(text(source.key))}".` };
        if (!op) return { skip: `Unsupported condition operator "${shorten(text(source.operator))}".` };
        const value = text(source.value);
        if (value === '') {
            notes.push('The URL condition is empty, so this rule matches every request.');
            return { pattern: '*', groups: 0 };
        }
        if (op === 'matches') return userRegexPattern(value, key, opts, notes);
        if (op === 'wildcard') return wildcardPattern(value, key, opts, notes);

        if (key === 'url') {
            if (op === 'equals') return regexPattern('^' + escapeRegex(value) + '$');
            if (!value.includes('*') && !opts.needsRegex) return { pattern: '*' + value + '*', groups: 0 };
            return regexPattern(escapeRegex(value));
        }
        if (key === 'host') {
            if (/[/?#]/.test(value)) return { skip: 'A host condition cannot contain "/", "?" or "#".' };
            const host = escapeRegex(value);
            return regexPattern(op === 'equals'
                ? '^https?:\\/\\/' + host + '(?:[\\/?#]|$)'
                : '^https?:\\/\\/[^\\/?#]*' + host);
        }
        // path
        if (op === 'equals') {
            if (value.charAt(0) !== '/') return { skip: 'A path condition has to start with "/"; a URL path never equals this, so Requestly would never match it.' };
            const tail = value === '/' ? '\\/?' : escapeRegex(value);
            return regexPattern('^https?:\\/\\/[^\\/?#]*' + tail + '(?:[?#]|$)');
        }
        return regexPattern(value.charAt(0) === '/'
            ? '^https?:\\/\\/[^?#]*' + escapeRegex(value)
            : '^https?:\\/\\/[^\\/?#]*\\/[^?#]*' + escapeRegex(value));
    }

    // ------------------------------------------------------------- filters

    function firstFilterGroup(raw, notes) {
        let list = raw;
        if (isObj(list)) list = [list];
        if (!Array.isArray(list)) return {};
        const meaningful = (g) => isObj(g) && Object.keys(g).some((k) => {
            const v = g[k];
            return Array.isArray(v) ? v.length > 0 : (isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '');
        });
        const groups = list.filter(meaningful);
        if (groups.length > 1) {
            notes.push(`The condition has ${groups.length} filter groups; only the first was imported, as Requestly's in-page matcher does.`);
        }
        return groups[0] || {};
    }

    function domainFromValue(value) {
        let s = text(value).trim().toLowerCase();
        if (!s) return null;
        s = s.replace(/^[a-z*][a-z0-9+.*-]*:\/\//, '');
        s = s.split(/[/?#]/)[0];
        s = s.replace(/^[^@]*@/, '');
        s = s.replace(/:\d+$/, '');
        s = s.replace(/^\*+\.?/, '').replace(/\*+$/, '');
        return HOST_RE.test(s) && s.length <= 253 ? s : null;
    }

    function collectPageDomains(f, notes) {
        const domains = [];
        if (Array.isArray(f.pageDomains) && f.pageDomains.length > 0) {
            // pageDomains wins over pageUrl, as in Requestly's own migration.
            f.pageDomains.forEach((d) => {
                const host = domainFromValue(d);
                if (host) domains.push(host);
                else notes.push(`Page domain "${shorten(text(d))}" was dropped: it is not a plain host name.`);
            });
            if (domains.length === 0) notes.push('The page-domain filter was dropped, so this rule applies on every page.');
        } else if (isObj(f.pageUrl) && text(f.pageUrl.value) !== '') {
            const value = text(f.pageUrl.value);
            const operator = normalizeOperator(f.pageUrl.operator);
            const host = operator === 'matches' ? null : domainFromValue(value);
            if (host) {
                domains.push(host);
                const afterScheme = value.trim().replace(/^[a-z*][a-z0-9+.*-]*:\/\//i, '');
                const tail = afterScheme.slice(afterScheme.split(/[/?#]/)[0].length);
                if (tail && tail !== '/' && tail !== '/*') {
                    notes.push(`The page URL "${shorten(value)}" became the page domain "${host}": SpliceTap matches the whole site, not one page.`);
                }
            } else {
                notes.push(`The page URL filter "${shorten(value)}" was dropped because no host could be taken from it, so this rule applies on every page.`);
            }
        }
        const deduped = unique(domains);
        if (deduped.length > 20) {
            notes.push(`SpliceTap allows 20 page domains; the first 20 of ${deduped.length} were kept.`);
            return deduped.slice(0, 20);
        }
        return deduped;
    }

    function applyFilters(f, payloadFilter, scope, notes) {
        const extra = {};

        const rawMethods = Array.isArray(f.requestMethod) ? f.requestMethod
            : (typeof f.requestMethod === 'string' ? [f.requestMethod] : []);
        const methods = [];
        const unsupported = [];
        rawMethods.forEach((m) => {
            const u = text(m).trim().toUpperCase();
            if (!u) return;
            if (SUPPORTED_METHODS.includes(u)) { if (!methods.includes(u)) methods.push(u); }
            else if (!unsupported.includes(u)) unsupported.push(u);
        });
        let method = '*';
        if (methods.length === 0 && unsupported.length > 0) {
            return { skip: `The rule only applies to ${unsupported.join(', ')} requests, which SpliceTap cannot match.` };
        }
        if (methods.length > 0 && methods.length < SUPPORTED_METHODS.length) {
            method = methods[0];
            if (methods.length > 1) {
                notes.push(`SpliceTap matches one method per rule: kept ${methods[0]}, dropped ${methods.slice(1).join(', ')}. Duplicate the rule for each method.`);
            }
        }
        if (unsupported.length > 0 && methods.length > 0) {
            notes.push(`Ignored request method(s) SpliceTap cannot match: ${unsupported.join(', ')}.`);
        }

        const domains = collectPageDomains(f, notes);
        if (domains.length > 0) extra.pageDomains = domains;

        const rawTypes = Array.isArray(f.resourceType) ? f.resourceType : [];
        if (rawTypes.length > 0) {
            const mapped = [];
            const unknown = [];
            rawTypes.forEach((t) => {
                const mine = RESOURCE_TYPES.get(text(t).toLowerCase());
                if (!mine) unknown.push(text(t));
                else if (!mapped.includes(mine)) mapped.push(mine);
            });
            if (mapped.length === 0) {
                return { skip: `The rule is limited to resource types SpliceTap does not know (${unknown.map((u) => shorten(u, 30)).join(', ')}).` };
            }
            if (unknown.length > 0) notes.push(`Ignored unknown resource type(s): ${unknown.map((u) => shorten(u, 30)).join(', ')}.`);
            if (scope === 'page') {
                if (!mapped.includes('fetch-xhr')) {
                    return { skip: `The rule only applies to ${mapped.join(', ')} requests, but SpliceTap applies this kind of rule to fetch and XHR requests only.` };
                }
                if (mapped.length > 1) {
                    notes.push(`The rule also listed ${mapped.filter((t) => t !== 'fetch-xhr').join(', ')}; SpliceTap applies this kind of rule to fetch and XHR requests only.`);
                }
            } else {
                extra.resourceTypes = mapped;
            }
        }

        if (payloadFilter) {
            const path = text(payloadFilter.key);
            if (path === '' || path.split('.').some((seg) => seg === '')) {
                return { skip: 'The request-payload filter has no usable key path (Requestly never matches such a filter).' };
            }
            if (payloadFilter.value === undefined || payloadFilter.value === null) {
                return { skip: 'The request-payload filter has no value (Requestly never matches such a filter).' };
            }
            const rawOp = text(payloadFilter.operator).toLowerCase();
            const operator = rawOp === '' || rawOp === 'equals' ? 'equals' : (rawOp === 'contains' ? 'contains' : null);
            if (!operator) {
                return { skip: `The request-payload filter uses the "${shorten(text(payloadFilter.operator), 30)}" operator; SpliceTap supports "equals" and "contains", the only two Requestly evaluates.` };
            }
            const value = text(payloadFilter.value);
            if (path.length > 200) return { skip: 'The request-payload key path is longer than 200 characters.' };
            if (value.length > 1000) return { skip: 'The request-payload value is longer than 1000 characters.' };
            extra.payload = { path, operator, value };
        }
        return { method, extra };
    }

    /**
     * The match block for one pair, and the scope the rule ends up with.
     * spec.scope: 'network' (headers, query: Chrome's network layer),
     * 'all' (block/redirect over every resource type) or 'page' (fetch/XHR in
     * the page). A payload filter can only be read in the page, so an 'all'
     * rule that has one becomes a page rule; a 'network' rule is skipped.
     * spec.url === null leaves the URL to the caller (Replace).
     */
    function prepareMatch(pair, env, spec) {
        const notes = env.notes;
        const source = isObj(pair) ? pair.source : null;
        if (!isObj(source)) return { skip: 'It has no URL condition (source).' };
        const filters = firstFilterGroup(source.filters, notes);
        const payloadFilter = isObj(filters.requestPayload) && Object.keys(filters.requestPayload).length > 0
            ? filters.requestPayload : null;
        let scope = spec.scope;
        if (payloadFilter) {
            if (scope === 'network') {
                return { skip: 'A request-payload filter needs the request body, which only rules applied in the page (fetch and XHR) can read; this rule type is applied by Chrome\'s network layer.' };
            }
            if (scope === 'all') {
                scope = 'page';
                notes.push('A request-payload filter can only be checked in the page, so this rule now applies to fetch and XHR requests only.');
            }
        }
        let url;
        let groups = 0;
        if (spec.url !== null) {
            const cond = conditionPattern(source, { network: scope !== 'page', needsRegex: !!spec.needsRegex }, notes);
            if (cond.skip) return cond;
            url = cond.pattern;
            groups = cond.groups;
        }
        const applied = applyFilters(filters, payloadFilter, scope, notes);
        if (applied.skip) return applied;
        if (source.isActive === false) {
            env.disabled = true;
            notes.push('The condition is switched off in Requestly, so the rule is imported turned off.');
        }
        const match = {};
        if (url !== undefined) match.url = url;
        match.method = applied.method;
        Object.assign(match, applied.extra);
        return { match, scope, groups };
    }

    // ------------------------------------------------------------- builders

    function checkCaptures(destination, groups, notes) {
        const refs = (destination.match(/\$[1-9]/g) || []).map((r) => Number(r.slice(1)));
        if (refs.length === 0) return;
        if (groups === 0) {
            notes.push('The destination contains $1-$9 but the condition has no capture groups, so it is used as written.');
        } else if (Math.max.apply(null, refs) > groups) {
            notes.push(`The destination refers to $${Math.max.apply(null, refs)} but the pattern captures only ${groups} group(s); Requestly would insert nothing there, SpliceTap leaves the text.`);
        }
    }

    function buildRedirect(pair, record, env) {
        const destination = text(pair.destination).trim();
        const kind = text(pair.destinationType).toLowerCase();
        if (destination === '') return { skip: 'The redirect has no destination.' };
        if (kind === 'map_local' || /^file:/i.test(destination)) {
            return { skip: 'This redirect points at a local file, which a browser extension cannot read.' };
        }
        const relative = destination.startsWith('/');
        if (!relative && !/^https?:\/\//i.test(destination)) {
            return { skip: 'The destination is not an http(s) URL or a path starting with "/".' };
        }
        const m = prepareMatch(pair, env, { scope: relative ? 'page' : 'all', needsRegex: /\$[1-9]/.test(destination) });
        if (m.skip) return m;
        if (relative) {
            env.notes.push('The destination is relative, so the redirect stays on the page\'s own origin and applies to fetch and XHR requests only.');
        }
        if (kind === 'mock_or_file_picker' || /(^|\.)requestly\.(tech|io)$/i.test(hostnameOf(destination))) {
            env.notes.push('The destination is a Requestly-hosted mock; it keeps working only while that mock exists.');
        }
        checkCaptures(destination, m.groups, env.notes);
        return { rules: [{ type: 'redirect', appliesTo: m.scope, match: m.match, redirect: { destination } }] };
    }

    function hostnameOf(url) {
        try {
            return new URL(url).hostname;
        } catch (e) {
            return '';
        }
    }

    function buildCancel(pair, record, env) {
        const m = prepareMatch(pair, env, { scope: 'all' });
        if (m.skip) return m;
        return { rules: [{ type: 'block', appliesTo: m.scope, match: m.match }] };
    }

    function buildDelay(pair, record, env) {
        const raw = text(pair.delay).trim();
        if (!/^\d+$/.test(raw)) return { skip: `The delay "${shorten(raw, 30)}" is not a whole number of milliseconds.` };
        let ms = Number(raw);
        const range = delayRange();
        if (ms < range.min) return { skip: 'A delay of 0 ms does nothing.' };
        const m = prepareMatch(pair, env, { scope: 'page' });
        if (m.skip) return m;
        if (ms > range.max) {
            env.notes.push(`The delay of ${ms} ms was capped at ${range.max} ms.`);
            ms = range.max;
        }
        env.notes.push('SpliceTap delays fetch and XHR requests only; Requestly delays every request.');
        return { rules: [{ type: 'delay', match: m.match, delayMs: ms }] };
    }

    function legacyHeaderModifications(pair) {
        if (isObj(pair.modifications)) return pair.modifications;
        // Version-1 header rules: one header per pair, with a `target` side.
        if (typeof pair.header === 'string') {
            const side = text(pair.target) === 'Response' ? 'Response' : 'Request';
            return { [side]: [{ header: pair.header, type: pair.type, value: pair.value }] };
        }
        return null;
    }

    function headerOps(mods, env) {
        const opts = env.opts;
        const schema = getSchema();
        const headersMod = {};
        const dropped = [];
        const appendedByRequestly = [];
        [['Request', 'request'], ['Response', 'response']].forEach(([requestlySide, key]) => {
            const list = Array.isArray(mods[requestlySide]) ? mods[requestlySide] : [];
            const ops = [];
            const seen = new Set();
            list.forEach((mod) => {
                if (!isObj(mod)) { dropped.push('an entry that is not a header operation'); return; }
                const name = text(mod.header).trim();
                const type = text(mod.type).toLowerCase();
                const value = text(mod.value);
                if (name === '') { dropped.push('an operation without a header name'); return; }
                if (name.toLowerCase() === '__proto__') { dropped.push(`${name} (not a usable header name)`); return; }
                let op;
                if (type === 'remove') op = { op: 'remove', name };
                else if (type === 'add' || type === 'modify') {
                    if (value === DYNAMIC_ORIGIN) {
                        dropped.push(`${name} (its value is filled in with the page's origin at request time by Requestly, which SpliceTap cannot do; set a fixed value in the editor)`);
                        return;
                    }
                    op = { op: 'set', name, value };
                } else { dropped.push(`${name} (unknown operation "${shorten(text(mod.type), 20)}")`); return; }

                if (schema && schema.validateHeadersMod) {
                    const res = schema.validateHeadersMod({ [key]: [op] });
                    if (!res.valid) {
                        dropped.push(`${name} (${res.errors[0].replace(/^(?:Request|Response) header #\d+: /, '')})`);
                        return;
                    }
                }
                const lower = name.toLowerCase();
                if (seen.has(lower)) { dropped.push(`${name} (listed twice on the ${key} side; only the first applies)`); return; }
                seen.add(lower);

                if (type === 'add') {
                    const requestlyAppends = key === 'response' || APPEND_SUPPORTED_REQUEST_HEADERS.includes(lower);
                    if (key === 'response' && opts.appendResponseAdd) op.op = 'append';
                    else if (requestlyAppends) appendedByRequestly.push(name);
                }
                ops.push(op);
            });
            if (ops.length > 0) headersMod[key] = ops;
        });
        return { headersMod, dropped, appendedByRequestly };
    }

    function headerRule(headersMod, m) {
        return { type: 'headers', match: m.match, headersMod };
    }

    function networkScopeNotes(env) {
        env.notes.push('Requestly applies this to every resource type; this rule affects fetch and XHR requests only unless you add resource types in the editor.');
    }

    function buildHeaders(pair, record, env) {
        const mods = legacyHeaderModifications(pair);
        if (!mods) return { skip: 'It has no header modifications.' };
        const { headersMod, dropped, appendedByRequestly } = headerOps(mods, env);
        if (!headersMod.request && !headersMod.response) {
            return { skip: 'No header operation could be imported' + (dropped.length ? `: ${dropped.join('; ')}.` : '.') };
        }
        const m = prepareMatch(pair, env, { scope: 'network' });
        if (m.skip) return m;
        if (dropped.length) env.notes.push(`Dropped header operation(s): ${dropped.join('; ')}.`);
        if (appendedByRequestly.length) {
            env.notes.push(`Requestly appends added headers to an existing value (${unique(appendedByRequestly).join(', ')}); SpliceTap sets them, replacing any existing value.`);
        }
        if (!m.match.resourceTypes) networkScopeNotes(env);
        return { rules: [headerRule(headersMod, m)] };
    }

    function buildUserAgent(pair, record, env) {
        const ua = text(pair.userAgent);
        if (ua.trim() === '') return { skip: 'The rule has no User-Agent value.' };
        const op = { op: 'set', name: 'User-Agent', value: ua };
        const schema = getSchema();
        if (schema && schema.validateHeadersMod) {
            const res = schema.validateHeadersMod({ request: [op] });
            if (!res.valid) return { skip: `The User-Agent value cannot be sent: ${res.errors[0].replace(/^Request header #1: /, '')}.` };
        }
        const m = prepareMatch(pair, env, { scope: 'network' });
        if (m.skip) return m;
        if (!m.match.resourceTypes) networkScopeNotes(env);
        return { rules: [headerRule({ request: [op] }, m)] };
    }

    function buildQueryParam(pair, record, env) {
        const mods = Array.isArray(pair.modifications) ? pair.modifications : [];
        let removeAll = false;
        const add = [];
        const remove = [];
        const dropped = [];
        mods.forEach((mod) => {
            if (!isObj(mod)) { dropped.push('an entry that is not a query-parameter change'); return; }
            const type = text(mod.type).toLowerCase();
            const param = text(mod.param).trim();
            if (type === 'remove all') { removeAll = true; return; }
            if (param === '') { dropped.push('a change without a parameter name'); return; }
            if (type === 'add') {
                const at = add.findIndex((p) => p.key === param);
                if (at !== -1) {
                    dropped.push(`"${param}" was added twice; the later value wins`);
                    add.splice(at, 1);
                }
                add.push({ key: param, value: text(mod.value) });
            } else if (type === 'remove') {
                if (!remove.includes(param)) remove.push(param);
            } else {
                dropped.push(`"${param}" (unknown change "${shorten(text(mod.type), 20)}")`);
            }
        });
        if (removeAll && (add.length || remove.length)) {
            dropped.push('Add/Remove entries next to "Remove All" (Requestly ignores them)');
            add.length = 0;
            remove.length = 0;
        }
        if (!removeAll && add.length === 0 && remove.length === 0) {
            return { skip: 'No query-parameter change could be imported' + (dropped.length ? `: ${dropped.join('; ')}.` : '.') };
        }
        const m = prepareMatch(pair, env, { scope: 'network' });
        if (m.skip) return m;
        if (dropped.length) env.notes.push(`Dropped query-parameter change(s): ${dropped.join('; ')}.`);
        if (!m.match.resourceTypes) networkScopeNotes(env);
        const queryParams = removeAll ? { add: [], remove: [], removeAll: true } : { add, remove };
        return { rules: [{ type: 'queryparams', match: m.match, queryParams }] };
    }

    function parseStatus(raw) {
        const s = text(raw).trim();
        if (s === '') return { none: true };
        const range = statusRange();
        const n = /^\d{3}$/.test(s) ? Number(s) : NaN;
        if (!(n >= range.min && n <= range.max)) {
            return { skip: `The status code "${shorten(s, 20)}" is not a whole number between ${range.min} and ${range.max}.` };
        }
        return { code: n };
    }

    function responseHeaders(raw, env) {
        const out = {};
        let entries = [];
        if (isObj(raw)) entries = Object.keys(raw).map((k) => [k, raw[k]]);
        else if (Array.isArray(raw)) entries = raw.filter(isObj).map((h) => [text(h.name || h.header), h.value]);
        const schema = getSchema();
        entries.forEach(([name, value]) => {
            const v = text(value);
            const n = text(name).trim();
            let reason = null;
            if (n === '' || n.toLowerCase() === '__proto__') reason = 'not a usable header name';
            else if (schema && schema.validateHeadersMod) {
                const res = schema.validateHeadersMod({ response: [{ op: 'set', name: n, value: v }] });
                if (!res.valid) reason = res.errors[0].replace(/^Response header #\d+: /, '');
            }
            if (reason) env.notes.push(`Dropped response header "${shorten(n, 40)}": ${reason}.`);
            else Object.defineProperty(out, n, { value: v, enumerable: true, writable: true, configurable: true });
        });
        return out;
    }

    function codeNotes(code, env) {
        const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
        // The default template destructures every field; only real uses count.
        const used = noComments.replace(/(?:const|let|var)\s*\{[^}]*\}\s*=\s*args\s*;?/g, '');
        if (/\b(?:response|responseJSON|responseType)\b/.test(used)) {
            env.notes.push('The code reads the real response (response, responseJSON or responseType). SpliceTap\'s code mode does not fetch it, so those values are undefined.');
        }
        if (/\$sharedState\b/.test(noComments)) {
            env.notes.push('The code uses $sharedState, which SpliceTap does not provide; it will throw and the request goes to the network.');
        }
        env.notes.push('Code responses are off by default; turn them on in SpliceTap\'s settings.');
    }

    // The contract's wrapper: build Requestly's `args`, call their function.
    // The result is returned as an envelope ({status?, body}) so a body that
    // itself looks like {body: ...} is not mistaken for one, and so the
    // rule's status code survives.
    function wrapResponseCode(code, status) {
        const fn = code.trim().replace(/[;\s]+$/, '');
        return [
            'const args = { method: request.method, url: request.url, requestHeaders: request.headers, requestData: request.json !== undefined ? request.json : request.body };',
            'const body = await (',
            fn,
            ')(args);',
            status ? `return { status: ${status}, body };` : 'return { body };'
        ].join('\n');
    }

    function buildResponse(pair, record, env) {
        const r = isObj(pair.response) ? pair.response : null;
        if (!r) return { skip: 'It has no response settings.' };
        if (pair.isCompressed === true) {
            return { skip: 'The response body is stored compressed in this export. Open the rule in Requestly and export it again.' };
        }
        const type = text(r.type).toLowerCase() || 'static';
        if (type === 'local_file') return { skip: 'This response is served from a local file, which a browser extension cannot read.' };
        if (type !== 'static' && type !== 'code') return { skip: `Unknown response type "${shorten(type, 20)}".` };
        if (text(r.resourceType) === 'static') {
            return { skip: 'This rule serves HTML, JS or CSS; SpliceTap mocks fetch and XHR responses only.' };
        }
        const status = parseStatus(r.statusCode);
        if (status.skip) return status;
        const m = prepareMatch(pair, env, { scope: 'page' });
        if (m.skip) return m;

        if (type === 'code') {
            const code = text(r.value);
            if (code.trim() === '') return { skip: 'The response code is empty.' };
            codeNotes(code, env);
            if (status.none) env.notes.push('No status code is set: Requestly keeps the server\'s status; SpliceTap answers 200 unless the code says otherwise.');
            return { rules: [{ type: 'mock', match: m.match, response: {
                mode: 'code', code: wrapResponseCode(code, status.code), headers: responseHeaders(r.headers, env), delay: 0
            } }] };
        }
        if (status.none) env.notes.push('No status code is set: Requestly keeps the server\'s status; SpliceTap answers 200.');
        const response = {
            mode: 'static',
            statusCode: status.code || 200,
            headers: responseHeaders(r.headers, env),
            delay: 0,
            body: text(r.value)
        };
        const statusText = text(r.statusText).trim();
        if (statusText) response.statusText = statusText;
        return { rules: [{ type: 'mock', match: m.match, response }] };
    }

    function buildRequest(pair, record, env) {
        const r = isObj(pair.request) ? pair.request : null;
        if (!r) return { skip: 'It has no request settings.' };
        if (pair.isCompressed === true) {
            return { skip: 'The request body is stored compressed in this export. Open the rule in Requestly and export it again.' };
        }
        const type = text(r.type).toLowerCase() || 'static';
        if (type === 'code') {
            return { skip: 'Request bodies written as code are not supported; only a fixed (static) request body can be imported.' };
        }
        if (type !== 'static') return { skip: `Unknown request type "${shorten(type, 20)}".` };
        const m = prepareMatch(pair, env, { scope: 'page' });
        if (m.skip) return m;
        return { rules: [{ type: 'requestBody', match: m.match, requestBody: { mode: 'static', body: text(r.value) } }] };
    }

    // Replace: the URL is rewritten by swapping `from` for `to`. A SpliceTap
    // redirect destination has to start with a full URL, so the scheme is
    // pinned in the regex and the destination (one rule per scheme when the
    // condition does not name one). Supported: an empty condition, or a URL
    // Contains/Equals condition that includes the `from` text (what Requestly's
    // own converter handles first); the rest cannot be combined faithfully.
    function buildReplace(pair, record, env) {
        const from = text(pair.from);
        const to = text(pair.to);
        if (from === '') return { skip: 'The Replace rule has no text to replace.' };
        if (from.length >= 3 && from.startsWith('/') && from.endsWith('/')) {
            return { skip: 'The text to replace is wrapped in slashes, which Requestly\'s browser extension reads as a regular expression and other Requestly versions as plain text.' };
        }
        if (/\$\d/.test(to)) return { skip: 'The replacement text contains $ followed by a digit, which SpliceTap would read as a capture reference.' };
        const lowerFrom = from.toLowerCase();
        if (lowerFrom.includes('://') || 'https://'.startsWith(lowerFrom) || 'http://'.startsWith(lowerFrom)) {
            return { skip: 'The replacement changes the URL scheme, which SpliceTap cannot express.' };
        }
        const source = isObj(pair.source) ? pair.source : {};
        const value = text(source.value);
        const key = normalizeKey(source.key);
        const op = normalizeOperator(source.operator);
        let schemes = ['http', 'https'];
        let regexFor;
        let parts = 1;

        if (value === '') {
            env.notes.push('The URL condition is empty, so this rule applies to every request whose URL contains the replaced text.');
            regexFor = (scheme) => `^${scheme}:\\/\\/(.*?)${escapeRegex(from)}(.*)`;
        } else if (key === 'url' && (op === 'equals' || op === 'contains') && value.includes(from)) {
            let v = value;
            const withScheme = /^(https?):\/\//i.exec(value);
            if (withScheme) {
                schemes = [withScheme[1].toLowerCase()];
                v = value.slice(withScheme[0].length);
            } else if (op === 'equals') {
                return { skip: 'An "equals" condition without a scheme can never match a full URL.' };
            } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
                return { skip: 'Only http and https URLs can be rewritten.' };
            }
            if (!v.includes(from)) return { skip: 'The replacement changes the URL scheme, which SpliceTap cannot express.' };
            const pieces = v.split(from);
            parts = pieces.length;
            if (parts > 9) return { skip: 'The text to replace appears in the condition more than 8 times.' };
            const last = parts - 1;
            regexFor = (scheme) => {
                const groups = pieces.map((p, i) => {
                    let g = escapeRegex(p);
                    if (i === 0 && op === 'contains' && !withScheme) g = '.*?' + g;
                    if (i === last && op === 'contains') g += '.*';
                    return `(${g})`;
                });
                return `^${scheme}:\\/\\/` + groups.join(escapeRegex(from)) + (op === 'equals' ? '$' : '');
            };
        } else {
            return { skip: 'SpliceTap cannot combine this Replace rule\'s URL condition with the text it replaces. It can import a Replace rule with an empty condition, or a URL "contains"/"equals" condition that includes the replaced text.' };
        }

        const m = prepareMatch(pair, env, { scope: 'all', url: null });
        if (m.skip) return m;
        const groupTotal = value === '' ? 2 : parts;
        const rules = schemes.map((scheme) => {
            let destination = `${scheme}://$1`;
            for (let i = 2; i <= groupTotal; i++) destination += `${to}$${i}`;
            if (value === '') destination = `${scheme}://$1${to}$2`;
            return {
                type: 'redirect',
                appliesTo: m.scope,
                nameSuffix: schemes.length > 1 ? ` (${scheme})` : '',
                match: Object.assign({ url: `/${regexFor(scheme)}/` }, m.match),
                redirect: { destination }
            };
        });
        if (schemes.length > 1) {
            env.notes.push('Imported as one rule per scheme (http and https), because a SpliceTap redirect destination has to start with a full URL.');
        }
        return { rules };
    }

    const BUILDERS = {
        redirect: buildRedirect,
        cancel: buildCancel,
        delay: buildDelay,
        headers: buildHeaders,
        queryparam: buildQueryParam,
        response: buildResponse,
        request: buildRequest,
        useragent: buildUserAgent,
        replace: buildReplace
    };

    // ------------------------------------------------------------- convert

    function convert(json, options) {
        const opts = Object.assign({}, DEFAULTS, isObj(options) ? options : {});
        const out = { rules: [], skipped: [], warnings: [] };
        const records = recordsOf(json);
        if (!records) {
            out.skipped.push({ name: FILE_LABEL, reason: 'This is not a Requestly rules export (expected a JSON list of rules and groups).' });
            return out;
        }

        const groups = new Map();
        records.forEach((r) => {
            if (kindOf(r) === 'group' && r.id !== undefined) groups.set(text(r.id), r);
        });
        const groupList = records.filter((r) => kindOf(r) === 'group');
        let sawGroupId = false;
        const schema = getSchema();

        records.forEach((record, index) => {
            const kind = kindOf(record);
            if (kind === 'group') return;
            if (kind !== 'rule') {
                out.skipped.push({
                    name: `Entry ${index + 1}`,
                    reason: isObj(record) ? 'It is not a rule or a group (no objectType "rule" or "group").' : 'It is not a rule object.'
                });
                return;
            }

            const ruleType = text(record.ruleType);
            const baseName = cleanName(record.name, `Unnamed ${ruleType || 'rule'}`);
            const skipAll = (reason) => out.skipped.push({ name: fitName(baseName, ''), reason });

            if (ruleType.toLowerCase() === 'script') {
                skipAll('Script rules (injecting JavaScript or CSS into pages) are not supported by SpliceTap.');
                return;
            }
            const builder = hasOwn(BUILDERS, ruleType.toLowerCase()) ? BUILDERS[ruleType.toLowerCase()] : null;
            if (!builder) {
                skipAll(ruleType ? `Unknown Requestly rule type "${shorten(ruleType, 30)}".` : 'It has no rule type.');
                return;
            }
            const pairs = Array.isArray(record.pairs) ? record.pairs : [];
            if (pairs.length === 0) {
                skipAll('It has no pairs (conditions).');
                return;
            }

            const groupId = text(record.groupId);
            let groupOff = null;
            if (groupId !== '') {
                sawGroupId = true;
                const group = groups.get(groupId);
                if (group && text(group.status).toLowerCase() !== 'active') groupOff = cleanName(group.name, groupId);
            }
            const active = text(record.status).toLowerCase() === 'active';

            pairs.forEach((pair, i) => {
                const pairSuffix = pairs.length > 1 ? ` #${i + 1}` : '';
                const label = fitName(baseName, pairSuffix);
                if (!isObj(pair)) {
                    out.skipped.push({ name: label, reason: 'The pair is not an object.' });
                    return;
                }
                const env = { opts, notes: [], disabled: false };
                let result;
                try {
                    result = builder(pair, record, env);
                } catch (e) {
                    result = { skip: `It could not be read (${e && e.message ? e.message : 'unexpected shape'}).` };
                }
                if (result.skip) {
                    out.skipped.push({ name: label, reason: result.skip });
                    return;
                }
                if (groupOff !== null) env.notes.push(`Turned off because its group "${groupOff}" is inactive in Requestly.`);

                const built = [];
                const failures = [];
                result.rules.forEach((spec) => {
                    const { nameSuffix, appliesTo, type, match } = spec;
                    const name = fitName(baseName, pairSuffix + (nameSuffix || ''));
                    const rule = { id: freshId(), name, type, enabled: active && !env.disabled && groupOff === null, created: new Date().toISOString() };
                    if (appliesTo !== undefined) rule.appliesTo = appliesTo;
                    rule.match = match;
                    ['response', 'requestBody', 'delayMs', 'redirect', 'headersMod', 'queryParams'].forEach((k) => {
                        if (spec[k] !== undefined) rule[k] = spec[k];
                    });
                    if (opts.validate && schema && schema.validateRule) {
                        const res = schema.validateRule(rule);
                        if (!res.valid) {
                            failures.push({ name, reason: res.errors.join(' ') });
                            return;
                        }
                    }
                    built.push(rule);
                });
                failures.forEach((f) => out.skipped.push(f));
                built.forEach((rule, n) => {
                    out.rules.push(rule);
                    if (n === 0 || result.rules.length === 1) {
                        unique(env.notes).forEach((message) => out.warnings.push({ name: rule.name, message }));
                    }
                });
            });
        });

        if (groupList.length > 0 || sawGroupId) {
            const names = groupList.map((g) => cleanName(g.name, text(g.id))).slice(0, 5);
            const more = groupList.length > 5 ? ` and ${groupList.length - 5} more` : '';
            out.warnings.push({
                name: FILE_LABEL,
                message: groupList.length > 0
                    ? `Groups are not supported yet: ${groupList.length} group(s) (${names.join(', ')}${more}) were ignored and their rules imported without them.`
                    : 'Groups are not supported yet: rules that belonged to a group were imported without it.'
            });
        }
        return out;
    }

    const api = { detect, convert };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapImporters = global.SpliceTapImporters || {};
    global.SpliceTapImporters.requestly = api;
})(typeof window !== 'undefined' ? window : globalThis);
