//! YouTube 播放器签名（`s` 参数）解密，纯 Rust 版。
//!
//! YouTube 给 Android/Web 客户端的自适应流 URL 里带一个被播放器脚本打乱过的
//! 签名 `s`，必须用 base.js 里的解密函数还原成 `signature` 参数，否则 CDN 一律 403。
//!
//! 这里的做法是 yt-dlp / rustube 那套经典流程的纯 Rust 直译：
//! 1. 从 base.js 里找入口函数：`X=function(a){a=a.split("")...}` 且名字出现在
//!    签名调用点（`.sig||X(` / `set("signature",X(` 等）附近；
//! 2. 用花括号配对提取所有 `X=function(a,b){...}` / `X:function(a,b){...}` 定义；
//! 3. 解释执行三类操作：`reverse` / `splice` / 交换两个元素，以及
//!    `for(var c=...;c--;)a.unshift(a.pop())` 这类旋转循环和子函数调用。
//!
//! 播放器脚本的形状每次发版都会变，所以执行器遇到不认识的语句**必须报错**，
//! 不能瞎猜——瞎猜出来的签名会静默 403，比报错难查得多。

use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use regex::Regex;

/// 从 base.js 里解析出来的播放器脚本：函数定义表 + 签名入口函数名。
#[derive(Debug, Clone)]
pub struct PlayerScript {
    functions: HashMap<String, FunctionDef>,
    entry: String,
}

#[derive(Debug, Clone)]
struct FunctionDef {
    #[allow(dead_code)]
    params: Vec<String>,
    body: String,
}

/// 临时变量能装两种东西：交换元素时暂存的字符、循环/计算用的数字。
#[derive(Debug, Clone, Copy)]
enum TempValue {
    Chr(char),
    Num(i64),
}

impl PlayerScript {
    /// 解析 base.js。失败说明脚本形状已经变化，需要更新这里的提取规则。
    pub fn parse(js: &str) -> Result<PlayerScript> {
        let (functions, order) = extract_functions(js);
        anyhow::ensure!(
            !functions.is_empty(),
            "播放器脚本里没有找到任何函数定义"
        );
        let entry =
            find_entry(js, &functions, &order).context("找不到播放器签名入口函数")?;
        Ok(PlayerScript { functions, entry })
    }

    /// 解出签名。输入是 signatureCipher 里的 `s`，输出可以直接拼进 URL。
    pub fn decipher(&self, signature: &str) -> Result<String> {
        let mut arr: Vec<char> = signature.chars().collect();
        exec_function(self, &self.entry, &mut arr, None)?;
        Ok(arr.into_iter().collect())
    }
}

// ---------------------------------------------------------------- 脚本提取

/// 三种定义形状：
/// - `X=function(a,b){...}` / `var X=function(a,b){...}` / `;X=function(...)`
/// - `obj.X=function(a,b){...}`（挂在对象上的成员）
/// - `X:function(a,b){...}`（大对象字面量里的成员）
const DEF_START: &str =
    r"(?m)(?:^|[;{},.]\s*|\bvar\s+)([A-Za-z0-9_$]+)\s*(?:=|:)\s*function\s*\(([^()]*)\)\s*\{";

/// 从 `{` 开始配对花括号，跳过字符串字面量，返回 body（不含两侧花括号）。
fn take_brace_block(text: &str, open: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    for (offset, ch) in bytes[open..].iter().enumerate() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if *ch == b'\\' {
                escaped = true;
            } else if *ch == q {
                quote = None;
            }
            continue;
        }
        match *ch {
            b'"' | b'\'' => quote = Some(*ch),
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let body = &text[open + 1..open + offset];
                    return Some((body.to_string(), open + offset + 1));
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_functions(js: &str) -> (HashMap<String, FunctionDef>, Vec<String>) {
    let re = Regex::new(DEF_START).expect("DEF_START 是合法正则");
    let mut out: HashMap<String, FunctionDef> = HashMap::new();
    // 定义顺序（按出现位置），兜底选入口时要"最后一个候选"——顺序不能丢在 HashMap 里
    let mut order: Vec<String> = Vec::new();
    for caps in re.captures_iter(js) {
        let name = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let params: Vec<String> = caps
            .get(2)
            .map(|m| {
                m.as_str()
                    .split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let Some(open) = caps.get(0).map(|m| m.end() - 1) else {
            continue;
        };
        let Some((body, _)) = take_brace_block(js, open) else {
            continue;
        };
        // 同名重定义：位置更新到后一次出现处
        if let Some(at) = order.iter().position(|existing| existing == name) {
            order.remove(at);
        }
        order.push(name.to_string());
        out.insert(
            name.to_string(),
            FunctionDef {
                params,
                body: body.trim().to_string(),
            },
        );
    }
    (out, order)
}

/// 入口函数候选：函数体的第一句是 `a=a.split("")`。
fn is_entry_candidate(def: &FunctionDef) -> bool {
    def.body.trim_start().starts_with("a=a.split(")
}

/// 在签名调用点里找入口函数名。多试几种调用形状，找到的还要真在候选表里才认。
fn find_entry(
    js: &str,
    functions: &HashMap<String, FunctionDef>,
    order: &[String],
) -> Option<String> {
    let patterns = [
        r"\.sig\|\|([A-Za-z0-9_$]+)\(",
        r#"set\(["']signature["'],\s*(?:[A-Za-z0-9_$]+\.)?([A-Za-z0-9_$]+)\("#,
        r#"["']signature["'],\s*([A-Za-z0-9_$]+)\("#,
        r"([A-Za-z0-9_$]+)\(decodeURIComponent\(",
    ];
    for pattern in patterns {
        let re = Regex::new(pattern).expect("调用点正则必须合法");
        if let Some(caps) = re.captures(js) {
            if let Some(name) = caps.get(1).map(|m| m.as_str()) {
                if functions.get(name).is_some_and(is_entry_candidate) {
                    return Some(name.to_string());
                }
            }
        }
    }
    // 兜底：历史上"最后一个 `=function(a){a=a.split("")`" 就是入口。
    // 调用点没认出来时用它，比直接失败强。
    order
        .iter()
        .rev()
        .find(|name| functions.get(*name).is_some_and(is_entry_candidate))
        .cloned()
}

// ---------------------------------------------------------------- 语句执行

/// 按 `;` 切分，跳过括号/花括号内部的 `;`（for 循环头里就有两个）。
fn split_statements(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut paren = 0i32;
    let mut brace = 0i32;
    let mut start = 0usize;
    for (index, ch) in body.char_indices() {
        match ch {
            '(' => paren += 1,
            ')' => paren -= 1,
            '{' => brace += 1,
            '}' => brace -= 1,
            ';' if paren == 0 && brace == 0 => {
                out.push(body[start..index].to_string());
                start = index + 1;
            }
            _ => {}
        }
    }
    if start < body.len() {
        out.push(body[start..].to_string());
    }
    out
}

fn exec_function(
    script: &PlayerScript,
    name: &str,
    arr: &mut Vec<char>,
    arg: Option<i64>,
) -> Result<()> {
    let def = script
        .functions
        .get(name)
        .with_context(|| format!("签名函数 {name} 的定义缺失"))?;
    let mut vars: HashMap<String, TempValue> = HashMap::new();
    if let Some(value) = arg {
        vars.insert("b".to_string(), TempValue::Num(value));
    }
    for statement in split_statements(&def.body) {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        if statement == "a.reverse()" {
            arr.reverse();
            continue;
        }
        if let Some(rest) = statement.strip_prefix("var ") {
            if rest.starts_with("a=a.split(") {
                continue;
            }
        }
        if statement.starts_with("a=a.split(") {
            continue;
        }
        if statement.starts_with("for(") {
            exec_rotate(statement, arr, &vars)?;
            continue;
        }
        if let Some(rest) = statement.strip_prefix("a.splice(") {
            exec_splice(rest, arr, &vars)?;
            continue;
        }
        if statement.starts_with("a[") {
            exec_array_assign(statement, arr, &vars)?;
            continue;
        }
        if let Some(rest) = statement.strip_prefix("var ") {
            exec_var_assign(rest, arr, &mut vars)?;
            continue;
        }
        if let Some((callee, args)) = parse_call(statement) {
            exec_call(script, &callee, &args, arr, &vars)?;
            continue;
        }
        if statement.starts_with("return") {
            break;
        }
        bail!("无法识别的签名语句：{statement}")
    }
    Ok(())
}

/// `for(var c=EXPR;c--;)a.unshift(a.pop())` 旋转循环。
fn exec_rotate(
    statement: &str,
    arr: &mut Vec<char>,
    vars: &HashMap<String, TempValue>,
) -> Result<()> {
    // 头部：for(INIT;COND;STEP)，之后紧跟循环体 {...}
    let Some(open) = statement.find('(') else {
        bail!("for 循环缺 (：{statement}");
    };
    let Some(close) = find_matching(statement, open, '(', ')') else {
        bail!("for 循环头没有闭合：{statement}");
    };
    let header = &statement[open + 1..close];
    // 循环体两种写法：带花括号 `{a.unshift(a.pop())}` 和单语句不带花括号
    let body = if let Some(brace_open) = statement[close + 1..]
        .find('{')
        .map(|at| close + 1 + at)
    {
        take_brace_block(statement, brace_open).context("for 循环体没有闭合")?.0
    } else {
        let rest = &statement[close + 1..];
        let end = rest.find(';').unwrap_or(rest.len());
        rest[..end].to_string()
    };
    let body = body.trim();
    let parts: Vec<&str> = header.split(';').collect();
    if parts.len() != 3 {
        bail!("for 循环头形状不识别：{statement}");
    }
    let (init, cond, step) = (parts[0].trim(), parts[1].trim(), parts[2].trim());
    if !step.is_empty() || !cond.ends_with("--") {
        bail!("for 循环形状不识别：{statement}");
    }
    let counter = cond.trim_end_matches("--").trim();
    let Some(expr) = init.strip_prefix("var ") else {
        bail!("for 循环初始化不识别：{statement}");
    };
    let Some((name, value)) = expr.split_once('=') else {
        bail!("for 循环计数器不识别：{statement}");
    };
    let name = name.trim();
    if name != counter {
        bail!("for 循环计数器不一致：{statement}");
    }
    let rounds = eval_expr(value.trim(), arr.len(), vars)
        .with_context(|| format!("for 循环计数表达式不识别：{value}"))?;
    let mut rounds = rounds.max(0) as usize;
    let right = body == "a.unshift(a.pop())";
    let left = body == "a.push(a.shift())";
    if !right && !left {
        bail!("for 循环体不识别：{body}");
    }
    rounds %= arr.len().max(1);
    for _ in 0..rounds {
        if right {
            let Some(last) = arr.pop() else {
                bail!("签名脚本试图旋转空数组");
            };
            arr.insert(0, last);
        } else if !arr.is_empty() {
            let first = arr.remove(0);
            arr.push(first);
        }
    }
    Ok(())
}

/// `a.splice(START)` / `a.splice(START, COUNT)`。
fn exec_splice(
    rest: &str,
    arr: &mut Vec<char>,
    vars: &HashMap<String, TempValue>,
) -> Result<()> {
    let args = rest
        .strip_suffix(')')
        .context("splice 缺少右括号")?
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if args.is_empty() || args.len() > 2 {
        bail!("splice 参数个数不识别：{rest}");
    }
    let start = eval_expr(args[0], arr.len(), vars)?;
    let count = match args.get(1) {
        Some(expr) => Some(eval_expr(expr, arr.len(), vars)?),
        None => None,
    };
    splice(arr, start, count)?;
    Ok(())
}

fn splice(arr: &mut Vec<char>, start: i64, count: Option<i64>) -> Result<()> {
    let len = arr.len() as i64;
    let start = splice_start(start, len)?;
    let count = match count {
        None => len - start as i64,
        Some(count) => {
            if count <= 0 {
                return Ok(());
            }
            count.min(len - start as i64)
        }
    };
    for _ in 0..count {
        arr.remove(start as usize);
    }
    Ok(())
}

/// JS `Array.splice` 的起点语义：负数从尾部数（回绕），大于长度夹到末尾。
fn splice_start(index: i64, len: i64) -> Result<i64> {
    if len == 0 {
        anyhow::ensure!(index <= 0, "签名脚本对空数组 splice 了正下标");
        return Ok(0);
    }
    if index < 0 {
        Ok(((index % len) + len) % len)
    } else {
        Ok(index.min(len))
    }
}

/// JS `a[I]` 的下标语义：必须落在 `[0, len)`，越界（例如 `a[a.length]`）报可读错误。
fn array_index(index: i64, len: usize) -> Result<usize> {
    anyhow::ensure!(len > 0, "签名脚本对空数组取了下标");
    anyhow::ensure!(
        (0..len as i64).contains(&index),
        "签名脚本下标越界（index={index}, len={len}）"
    );
    Ok(index as usize)
}

/// 形如 `a[I]=a[J]` / `a[I]=c` 的赋值语句。
fn exec_array_assign(
    statement: &str,
    arr: &mut Vec<char>,
    vars: &HashMap<String, TempValue>,
) -> Result<()> {
    let Some(close) = find_matching(statement, 0, '[', ']') else {
        bail!("数组赋值不识别：{statement}");
    };
    // 下标在 `a[` 和 `]` 之间
    let index_expr = &statement[2..close];
    let Some(rest) = statement[close + 1..].strip_prefix('=') else {
        bail!("数组语句不是赋值：{statement}");
    };
    let value = rest.trim();
    let index = eval_expr(index_expr, arr.len(), vars)?;
    let index = array_index(index, arr.len())?;
    if let Some(_inner) = value.strip_prefix("a[") {
        let inner_close = find_matching(value, 1, '[', ']').context("数组下标不闭合")?;
        let source = eval_expr(&value[2..inner_close], arr.len(), vars)?;
        let source = array_index(source, arr.len())?;
        arr[index] = arr[source];
        return Ok(());
    }
    if let Some(found) = vars.get(value).copied() {
        match found {
            TempValue::Chr(ch) => {
                arr[index] = ch;
                return Ok(());
            }
            TempValue::Num(_) => bail!("把数字赋给签名数组没有意义：{statement}"),
        }
    }
    bail!("数组赋值右值不识别：{statement}")
}

/// `var c=a[I]` / `var c=N` 等临时变量定义。
fn exec_var_assign(
    rest: &str,
    arr: &[char],
    vars: &mut HashMap<String, TempValue>,
) -> Result<()> {
    let Some((name, value)) = rest.split_once('=') else {
        bail!("变量定义不识别：{rest}");
    };
    let name = name.trim().to_string();
    let value = value.trim();
    if let Some(_inner) = value.strip_prefix("a[") {
        let close = find_matching(value, 1, '[', ']').context("数组下标不闭合")?;
        let index = eval_expr(&value[2..close], arr.len(), vars)?;
        let index = array_index(index, arr.len())?;
        vars.insert(name, TempValue::Chr(arr[index]));
        return Ok(());
    }
    let number = eval_expr(value, arr.len(), vars)?;
    vars.insert(name, TempValue::Num(number));
    Ok(())
}

/// 调用形状：`X(a)` / `X(a,N)` / `A.B(a,N)` / `A.B.call(null,a,N)`。
fn parse_call(statement: &str) -> Option<(String, String)> {
    let open = statement.find('(')?;
    if !statement.ends_with(')') {
        return None;
    }
    let callee = statement[..open].trim();
    let args_raw = &statement[open + 1..statement.len() - 1];
    // `.call(null, a, N)`：函数名是 `.call` 前面的成员，第一个参数是 this，丢掉。
    let (callee_name, args) = if callee.ends_with(".call") {
        let base = callee.strip_suffix(".call")?;
        let rest = args_raw.split_once(',').map(|(_, rest)| rest).unwrap_or("");
        (base, rest.trim())
    } else {
        (callee, args_raw.trim())
    };
    if callee_name.is_empty() || callee_name.contains(' ') {
        return None;
    }
    // 对象前缀（`A.B` → `B`）；函数表里只有成员名。
    let name = callee_name.rsplit('.').next().unwrap_or(callee_name);
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
    {
        return None;
    }
    Some((name.to_string(), args.to_string()))
}

fn exec_call(
    script: &PlayerScript,
    name: &str,
    args: &str,
    arr: &mut Vec<char>,
    vars: &HashMap<String, TempValue>,
) -> Result<()> {
    let args: Vec<String> = args.split(',').map(|arg| arg.trim().to_string()).collect();
    // 第一个实参必须是数组本身
    if args.is_empty() || args[0] != "a" {
        bail!(
            "签名函数调用的第一个实参必须是 a：{name}({})",
            args.join(", ")
        );
    }
    let numeric = match args.get(1) {
        Some(expr) => Some(eval_expr(expr, arr.len(), vars)?),
        None => None,
    };
    exec_function(script, name, arr, numeric)
}

// ---------------------------------------------------------------- 表达式求值

/// 支持：整数、括号、`+ - * / %`、`a.length`、变量（b 等）。
fn eval_expr(expr: &str, array_len: usize, vars: &HashMap<String, TempValue>) -> Result<i64> {
    let expr = expr.trim();
    if expr.is_empty() {
        bail!("空表达式");
    }
    let (value, used) = parse_add(expr, array_len, vars)?;
    anyhow::ensure!(used == expr.len(), "表达式没有解析完：{expr}");
    Ok(value)
}

fn parse_add(
    expr: &str,
    array_len: usize,
    vars: &HashMap<String, TempValue>,
) -> Result<(i64, usize)> {
    let (mut value, mut at) = parse_mul(expr, array_len, vars)?;
    loop {
        at = skip_ws(expr, at);
        let Some(op) = expr[at..].chars().next() else {
            break;
        };
        if op != '+' && op != '-' {
            break;
        }
        let (rhs, next) = parse_mul(&expr[at + 1..], array_len, vars)?;
        value = if op == '+' { value + rhs } else { value - rhs };
        at = at + 1 + next;
    }
    Ok((value, at))
}

fn parse_mul(
    expr: &str,
    array_len: usize,
    vars: &HashMap<String, TempValue>,
) -> Result<(i64, usize)> {
    let (mut value, mut at) = parse_primary(expr, array_len, vars)?;
    loop {
        at = skip_ws(expr, at);
        let Some(op) = expr[at..].chars().next() else {
            break;
        };
        if op != '*' && op != '/' && op != '%' {
            break;
        }
        let (rhs, next) = parse_primary(&expr[at + 1..], array_len, vars)?;
        value = match op {
            '*' => value * rhs,
            '/' => value.checked_div(rhs).context("除以零")?,
            '%' => value.checked_rem(rhs).context("模零")?,
            _ => unreachable!(),
        };
        at = at + 1 + next;
    }
    Ok((value, at))
}

fn parse_primary(
    expr: &str,
    array_len: usize,
    vars: &HashMap<String, TempValue>,
) -> Result<(i64, usize)> {
    let at = skip_ws(expr, 0);
    if at >= expr.len() {
        bail!("表达式不完整：{expr}");
    }
    let rest = &expr[at..];
    // 一元负号
    if rest.starts_with('-') {
        let (value, used) = parse_primary(rest.strip_prefix('-').unwrap(), array_len, vars)?;
        return Ok((-value, at + 1 + used));
    }
    if let Some(inner) = rest.strip_prefix('(') {
        let (value, used) = parse_add(inner, array_len, vars)?;
        let after = skip_ws(inner, used);
        let Some(_after_inner) = inner[after..].strip_prefix(')') else {
            bail!("括号不闭合：{expr}");
        };
        return Ok((value, at + 1 + after + 1));
    }
    if rest.starts_with("a.length") {
        return Ok((array_len as i64, at + "a.length".len()));
    }
    // 数字字面量（标识符不能以数字开头，先按数字解析）
    if rest.starts_with(|ch: char| ch.is_ascii_digit()) {
        let number_len = rest
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .map(char::len_utf8)
            .sum::<usize>();
        let number: i64 = rest[..number_len]
            .parse()
            .context("数字字面量解析失败")?;
        return Ok((number, at + number_len));
    }
    // 标识符
    let ident_len = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '$')
        .map(char::len_utf8)
        .sum::<usize>();
    if ident_len > 0 {
        let ident = &rest[..ident_len];
        if ident == "a" {
            bail!("表达式里的 a 只能是 a.length：{expr}");
        }
        let value = match vars.get(ident) {
            Some(TempValue::Num(number)) => *number,
            Some(TempValue::Chr(_ch)) => {
                // 数字语义：JS 里字符串参与算术会被强转，签名脚本不会这么写
                bail!("变量 {ident} 是字符不是数字：{expr}");
            }
            None => bail!("未定义的变量 {ident}：{expr}"),
        };
        return Ok((value, at + ident_len));
    }
    bail!("表达式不识别：{expr}")
}

fn skip_ws(text: &str, mut at: usize) -> usize {
    while text[at..].chars().next().is_some_and(char::is_whitespace) {
        at += text[at..].chars().next().unwrap().len_utf8();
    }
    at
}

/// 从 `open` 处的括号开始配对，返回内部文本（不含两端括号）。
fn find_matching(text: &str, open: usize, open_ch: char, close_ch: char) -> Option<usize> {
    let mut depth = 0i32;
    for (index, ch) in text[open..].char_indices() {
        if ch == open_ch {
            depth += 1;
        } else if ch == close_ch {
            depth -= 1;
            if depth == 0 {
                return Some(open + index);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(functions: &str, entry: &str, call_site: &str) -> String {
        format!(
            "var dummy=0;{functions}\nvar unused=function(a){{a=a.split(\"\");a.reverse();return a.join(\"\")}};{entry};{call_site}"
        )
    }

    #[test]
    fn reverse_only_entry_works() {
        let js = script("", "var rv=function(a){a=a.split(\"\");a.reverse();return a.join(\"\")};", "d.set(\"signature\",rv(x))");
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abc").unwrap(), "cba");
    }

    #[test]
    fn splice_and_swap_helpers_are_recursively_executed() {
        let js = script(
            r#"
            var hl={};
            hl.cut=function(a,b){a.splice(0,b)};
            hl.swp=function(a,b){var c=a[0];a[0]=a[b%a.length];a[b]=c};
            var en=function(a){a=a.split("");hl.cut(a,2);hl.swp(a,1);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        // "abcde" → cut(0,2) → "cde" → swap(0,1) → "dce"
        assert_eq!(parsed.decipher("abcde").unwrap(), "dce");
    }

    #[test]
    fn object_member_call_form_is_handled() {
        let js = script(
            r#"
            var ob={x:function(a){a.splice(0,1);return a.join("")}};
            var en=function(a){a=a.split("");ob.x(a);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abc").unwrap(), "bc");
    }

    #[test]
    fn rotate_right_loop_moves_the_tail_to_the_front() {
        let js = script(
            r#"
            var rot=function(a,b){for(var c=(b%a.length+a.length)%a.length;c--;)a.unshift(a.pop())};
            var en=function(a){a=a.split("");rot(a,1);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abc").unwrap(), "cab");
    }

    #[test]
    fn rotate_left_loop_moves_the_head_to_the_tail() {
        let js = script(
            r#"
            var rot=function(a,b){for(var c=(b%a.length+a.length)%a.length;c--;)a.push(a.shift())};
            var en=function(a){a=a.split("");rot(a,2);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abcde").unwrap(), "cdeab");
    }

    #[test]
    fn call_site_name_selects_the_right_entry_among_candidates() {
        // 两个都长得像入口，但调用点说的是 second
        let js = script(
            r#"
            var first=function(a){a=a.split("");a.reverse();return a.join("")};
            var second=function(a){a=a.split("");a.splice(0,1);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",second(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abc").unwrap(), "bc");
    }

    #[test]
    fn dot_sig_call_site_is_recognized() {
        let js = script(
            "",
            "var en=function(a){a=a.split(\"\");a.reverse();return a.join(\"\")};",
            "h.sig||en(m)",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("xyz").unwrap(), "zyx");
    }

    #[test]
    fn call_via_call_method_is_supported() {
        let js = script(
            r#"
            var ob={x:function(a){a.splice(0,2);return a.join("")}};
            var en=function(a){a=a.split("");ob.x.call(null,a);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        assert_eq!(parsed.decipher("abcde").unwrap(), "cde");
    }

    #[test]
    fn unknown_statement_fails_loudly() {
        let js = script(
            "",
            "var en=function(a){a=a.split(\"\");a.something;a.reverse();return a.join(\"\")};",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        let error = parsed.decipher("abc").unwrap_err().to_string();
        assert!(error.contains("无法识别"), "要报清楚哪句不认识：{error}");
    }

    #[test]
    fn out_of_bounds_index_fails_with_an_error_not_a_panic() {
        // a[a.length] 在 JS 里是 undefined；播放器脚本真出现这种形状时，
        // 必须给可读错误而不是越界 panic。
        let js = script(
            "",
            "var en=function(a){a=a.split(\"\");var c=a[a.length];return a.join(\"\")};",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        let error = parsed.decipher("abc").unwrap_err().to_string();
        assert!(error.contains("下标越界"), "{error}");
    }

    #[test]
    fn full_combo_executes_all_operation_kinds() {
        let js = script(
            r#"
            var o={};
            o.cut=function(a,b){a.splice(0,b)};
            o.swp=function(a,b){var c=a[0];a[0]=a[b%a.length];a[b]=c};
            o.rot=function(a,b){for(var c=(b%a.length+a.length)%a.length;c--;)a.unshift(a.pop())};
            var en=function(a){a=a.split("");o.cut(a,3);o.rot(a,41);a.reverse();o.swp(a,7);a.splice(2,1);return a.join("")};
            "#,
            "",
            "d.set(\"signature\",en(x))",
        );
        let parsed = PlayerScript::parse(&js).unwrap();
        // 手工推演："0123456789abcdef" → cut(0,3) → rotate 41%13=2 → reverse → swap(7) → splice(2,1)
        assert_eq!(parsed.decipher("0123456789abcdef").unwrap(), "6ca987d543fe");
    }

    #[test]
    fn expression_evaluator_handles_precedence_and_modulo() {
        let vars = HashMap::from([("b".to_string(), TempValue::Num(41))]);
        assert_eq!(eval_expr("(b%a.length+a.length)%a.length", 10, &vars).unwrap(), 1);
        assert_eq!(eval_expr("1+2*3", 10, &vars).unwrap(), 7);
        assert_eq!(eval_expr("a.length-1", 10, &vars).unwrap(), 9);
        assert!(eval_expr("nope+1", 10, &vars).is_err());
    }

    #[test]
    fn statement_splitter_ignores_semicolons_inside_for_headers() {
        let body = "var c=a[0];for(var d=(b%a.length+a.length)%a.length;d--;)a.unshift(a.pop());a.reverse()";
        let parts = split_statements(body);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert!(parts[1].starts_with("for("));
    }
}
