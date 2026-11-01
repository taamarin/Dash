#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', 'htdocs/luci-static/resources/view/singbox-dash/v70');
const lib = file => path.join(root, 'lib', file);
const pages = file => path.join(root, 'pages', file);

function loadLuciModule(file, bindings) {
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(/^'require[^']*';\s*$/gm, '');
    const names = Object.keys(bindings);
    const values = names.map(name => bindings[name]);
    const wrapper = `(function(${names.join(',')}) {\n${source}\n})`;
    return vm.runInNewContext(wrapper, { console }, { filename: file })(...values);
}

const noop = () => {};
const baseclass = { extend: value => value };
const ui = {
    badge: (label, tone) => ({ label, tone }),
    E: () => ({}),
    icon: noop,
    appIcon: noop
};

const rules = loadLuciModule(lib('rule-model.js'), { baseclass });
const direct = rules.buildRule('__direct', 'domain_suffix', ['openai.com']);
assert.equal(JSON.stringify(direct), JSON.stringify({ action: 'direct', domain_suffix: ['openai.com'] }));
assert.equal(JSON.stringify(rules.validateValues('port', '443\n8443')), JSON.stringify(['443', '8443']));
assert.equal(JSON.stringify(rules.simpleRule(direct)), JSON.stringify({
    field: 'domain_suffix', values: ['openai.com'], action: 'direct', outbound: ''
}));
assert.strictEqual(rules.categoryOf(direct, {}), 'direct');
assert.strictEqual(rules.targetLabel(direct, {}), 'Langsung');
assert.strictEqual(rules.isCatchAll({ action: 'reject' }), true);
let invalidPortRejected = false;
try { rules.validateValues('port', '0'); } catch (_) { invalidPortRejected = true; }
assert.strictEqual(invalidPortRejected, true);

const configModel = loadLuciModule(lib('config-model.js'), { baseclass, ui });
const dnsBadges = configModel.groupBadges({ dns: { servers: [1, 2], rules: [1] } }, 'dns');
assert.strictEqual(dnsBadges.length, 2);
assert.ok(dnsBadges[0].label.includes('2'));
assert.strictEqual(configModel.TILE_SPAN(3), 'sbd-config-span-2');

const ruleEditor = loadLuciModule(lib('rule-editor.js'), {
    baseclass, ui, ruleModel: rules
});
const configProviderEditor = loadLuciModule(lib('config-provider-editor.js'), {
    baseclass, ui, api: {}
});
const rulesPage = loadLuciModule(pages('rules.js'), {
    baseclass, ui: {}, api: {}, components: {}, ruleModel: rules, ruleEditor
});
assert.strictEqual(typeof rulesPage.render, 'function');
const configPage = loadLuciModule(pages('config.js'), {
    baseclass, ui: {}, api: {}, components: {}, schemaForm: {}, configModel,
    configHub: { render: noop, refreshTileSummaries: noop }, configProviderEditor
});
assert.strictEqual(typeof configPage.render, 'function');
const configHub = loadLuciModule(lib('config-hub.js'), { baseclass, ui, configModel });
assert.strictEqual(typeof configHub.render, 'function');
assert.strictEqual(typeof configHub.refreshTileSummaries, 'function');
const indexPage = loadLuciModule(path.join(root, 'index.js'), {
    view: { extend: value => value }, ui: {}, api: {}
});
assert.strictEqual(typeof indexPage.render, 'function');

const components = loadLuciModule(lib('components.js'), { baseclass, ui });
const schemaModel = loadLuciModule(lib('schema-model.js'), { baseclass });
const schemaEditor = loadLuciModule(lib('schema-editor.js'), { baseclass, ui, schemaModel });
const schemaForm = loadLuciModule(lib('schema-form.js'), { baseclass, schemaModel, schemaEditor });
assert.strictEqual(typeof schemaModel.resolveSchema, 'function');
assert.strictEqual(typeof schemaEditor.renderTopLevel, 'function');
assert.strictEqual(typeof schemaForm.renderTopLevel, 'function');
for (const name of ['overview', 'proxies', 'subscriptions', 'connections', 'trace',
                    'rules', 'config', 'kernel', 'tools', 'settings']) {
    const page = loadLuciModule(pages(name + '.js'), {
        baseclass, ui, api: {}, components, schemaForm, ruleModel: rules,
        ruleEditor, configProviderEditor, configModel, configHub, config: configModel
    });
    assert.strictEqual(typeof page.render, 'function', name);
}

console.log('frontend models, lazy index and all page module tests OK');
