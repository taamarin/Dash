/* Manager CLI execution, retry policy and user-facing error normalization. */
'use strict';
'require baseclass';
'require fs';

const BIN = '/usr/bin/singbox-dash/singbox-dash';

function errorInfo(error) {
    if (!error) return { kind: 'unknown', text: '操作失败，请刷新页面后重试。' };
    const raw = (typeof error === 'string' ? error : String(
        error.message || error.stdout || error.stderr || error
    )).replace(/^Error:\s*/, '').trim();
    if (!raw) return { kind: 'unknown', text: '操作失败，请刷新页面后重试。' };
    if (/XHR request timed out/i.test(raw))
        return { kind: 'timeout', text: '请求超时：后台任务可能仍在执行。请稍候刷新，或到“诊断与日志”查看 sing-box 错误。' };
    if (/XHR request aborted by browser/i.test(raw))
        return { kind: 'aborted', text: '请求被浏览器中断：请保持页面打开并重试；若持续发生，请到“诊断与日志”确认后台任务状态。' };
    if (/没有订阅地址|未配置订阅|subscription URL/i.test(raw))
        return { kind: 'subscription', text: '尚未配置订阅地址。请先在配置中心填写订阅 URL 并保存。' };
    if (/内核|SHA256|架构|ABI|ELF|glibc|musl/i.test(raw))
        return { kind: 'kernel', text: '内核问题：' + raw + '。请确认文件与当前设备架构、libc 和构建类型匹配，然后重新下载或上传。' };
    if (/Clash API|external_controller|clash_api/i.test(raw))
        return { kind: 'clash', text: 'Clash API 配置问题：' + raw + '。请检查配置中的 external_controller、端口和 secret。' };
    if (/上传|cgi-upload|文件大小|文件为空/i.test(raw))
        return { kind: 'upload', text: '上传失败：' + raw + '。请确认文件未超过限制，保持页面打开后重试。' };
    if (/配置|sing-box check|JSON|YAML|入站|出站|规则/i.test(raw))
        return { kind: 'config', text: '配置问题：' + raw + '。请修正后重新校验；原配置不会被覆盖。' };
    if (/network|fetch|timeout|TLS|certificate|HTTP|URL|GitHub|DNS|连接|证书/i.test(raw))
        return { kind: 'network', text: '网络问题：' + raw + '。请检查路由器上游网络、代理和 DNS 后重试。' };
    if (/进程|启动|停止|重启|service/i.test(raw))
        return { kind: 'service', text: '服务问题：' + raw + '。请刷新状态；若进程异常，请到诊断页面检查日志。' };
    if (/^(?:操作失败|Error)[：:]\s*/.test(raw))
        return { kind: 'unknown', text: raw };
    return { kind: 'unknown', text: '操作失败：' + raw };
}

function errorText(error) {
    return errorInfo(error).text;
}

function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function transientError(error) {
    return errorText(error).search(/timed out|timeout|超时|aborted|Resource temporarily unavailable/i) >= 0;
}

async function commandOnce(action, args) {
    const name = String(action == null ? '' : action).trim();
    if (!name)
        throw new Error('页面请求缺少操作命令，请刷新页面后重试');
    const result = await fs.exec(BIN, [name].concat((args || []).map(String)));
    const stdout = String((result && result.stdout) || '').trim();
    const stderr = String((result && result.stderr) || '').trim();
    if (!stdout)
        throw new Error(stderr || '管理服务没有返回结果，请重试');
    let value = null;
    if (stdout) {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        try {
            value = JSON.parse(lines[lines.length - 1]);
        } catch (_) {
            throw new Error(stderr || stdout.slice(-500) || '管理服务返回了无效结果');
        }
    }
    if ((result && Number(result.code || 0) !== 0) || (value && value.ok === false))
        throw new Error((value && value.error) || stderr || '管理操作失败');
    return value;
}

async function command(action, args, options) {
    const name = String(action == null ? '' : action).trim();
    if (!name)
        throw new Error('页面请求缺少操作命令，请刷新页面后重试');
    const retries = Math.max(0, Number(options && options.retries) || 0);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await commandOnce(name, args);
        } catch (error) {
            lastError = error;
            if (attempt >= retries || !transientError(error)) break;
            await sleep(280 * (attempt + 1));
        }
    }
    const wrapped = new Error(errorText(lastError));
    if (lastError && lastError.name) wrapped.name = lastError.name;
    throw wrapped;
}

return baseclass.extend({ BIN, errorInfo, errorText, sleep, transientError, commandOnce, command });
