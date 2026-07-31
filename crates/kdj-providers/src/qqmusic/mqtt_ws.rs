//! 最小 MQTT 5.0 over WebSocket 客户端。
//!
//! 只覆盖 QQ 音乐 App 扫码登录需要的 CONNECT / SUBSCRIBE / 收 PUBLISH / PING。

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::time::{interval, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const PROP_SERVER_KEEP_ALIVE: u8 = 0x13;
const PROP_SERVER_REFERENCE: u8 = 0x1C;
const PROP_AUTH_METHOD: u8 = 0x15;
const PROP_USER_PROPERTY: u8 = 0x26;

const REASON_SUCCESS: u8 = 0x00;
const REASON_USE_ANOTHER_SERVER: u8 = 0x9C;
const REASON_SERVER_MOVED: u8 = 0x9D;

#[derive(Debug, Clone)]
pub struct MqttPublish {
    pub topic: String,
    pub payload: Vec<u8>,
    pub user_properties: Vec<(String, String)>,
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

pub struct MqttWsClient {
    write: futures_util::stream::SplitSink<WsStream, Message>,
    read: futures_util::stream::SplitStream<WsStream>,
    buffer: Vec<u8>,
    keep_alive: u16,
    packet_id: u16,
}

impl MqttWsClient {
    pub async fn connect(
        host: &str,
        path: &str,
        client_id: &str,
        keep_alive: u16,
        auth_method: &str,
        user_properties: &[(&str, &str)],
        max_redirects: usize,
    ) -> Result<Self> {
        let mut current_path = path.to_string();
        for _ in 0..=max_redirects {
            let mut client = Self::connect_once(
                host,
                &current_path,
                client_id,
                keep_alive,
                auth_method,
                user_properties,
            )
            .await?;
            let (reason, props) = client.wait_connack().await?;
            if reason == REASON_SUCCESS {
                if let Some(server_keep_alive) = props.server_keep_alive {
                    client.keep_alive = server_keep_alive;
                }
                return Ok(client);
            }
            if matches!(reason, REASON_USE_ANOTHER_SERVER | REASON_SERVER_MOVED) {
                if let Some(reference) = props.server_reference {
                    current_path = redirect_path(&current_path, &reference);
                    let _ = client.write.close().await;
                    continue;
                }
            }
            bail!("MQTT CONNACK 失败：reason=0x{reason:02x}");
        }
        bail!("MQTT 重定向次数过多")
    }

    async fn connect_once(
        host: &str,
        path: &str,
        client_id: &str,
        keep_alive: u16,
        auth_method: &str,
        user_properties: &[(&str, &str)],
    ) -> Result<Self> {
        let url = format!("wss://{host}{path}");
        let mut request = url
            .as_str()
            .into_client_request()
            .with_context(|| format!("构造 MQTT WebSocket 请求失败：{url}"))?;
        let headers = request.headers_mut();
        headers.insert("Origin", HeaderValue::from_static("https://y.qq.com"));
        headers.insert("Referer", HeaderValue::from_static("https://y.qq.com/"));
        headers.insert("Sec-WebSocket-Protocol", HeaderValue::from_static("mqtt"));
        headers.insert(
            "User-Agent",
            HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            ),
        );

        let (stream, _) = timeout(Duration::from_secs(20), connect_async(request))
            .await
            .context("连接 MQTT WebSocket 超时")?
            .with_context(|| format!("连接 MQTT WebSocket 失败：{url}"))?;
        let (mut write, read) = stream.split();

        let connect_packet = encode_connect(client_id, keep_alive, auth_method, user_properties);
        write
            .send(Message::Binary(connect_packet.into()))
            .await
            .context("发送 MQTT CONNECT 失败")?;

        Ok(Self {
            write,
            read,
            buffer: Vec::new(),
            keep_alive,
            packet_id: 1,
        })
    }

    async fn wait_connack(&mut self) -> Result<(u8, ConnackProps)> {
        let packet = self
            .next_packet()
            .await?
            .context("MQTT 连接在 CONNACK 前关闭")?;
        let (packet_type, _flags, payload) = decode_packet(&packet)?;
        anyhow::ensure!(packet_type == 2, "期望 CONNACK，收到 type={packet_type}");
        anyhow::ensure!(payload.len() >= 2, "CONNACK 过短");
        let reason = payload[1];
        let props = if payload.len() > 2 {
            parse_properties(&payload[2..])?
        } else {
            ConnackProps::default()
        };
        Ok((reason, props))
    }

    pub async fn subscribe(&mut self, topic: &str, user_properties: &[(&str, &str)]) -> Result<()> {
        let id = self.next_packet_id();
        let packet = encode_subscribe(id, topic, user_properties);
        self.write
            .send(Message::Binary(packet.into()))
            .await
            .context("发送 MQTT SUBSCRIBE 失败")?;

        let packet = self
            .next_packet()
            .await?
            .context("MQTT 连接在 SUBACK 前关闭")?;
        let (packet_type, _, payload) = decode_packet(&packet)?;
        anyhow::ensure!(packet_type == 9, "期望 SUBACK，收到 type={packet_type}");
        anyhow::ensure!(payload.len() >= 3, "SUBACK 过短");
        let reason = payload[payload.len() - 1];
        anyhow::ensure!(reason <= 2, "SUBACK 失败：reason={reason}");
        Ok(())
    }

    pub async fn next_publish(&mut self) -> Result<Option<MqttPublish>> {
        let ping_every =
            Duration::from_secs(u64::from(self.keep_alive.max(1)) / 2).max(Duration::from_secs(5));
        let mut ping = interval(ping_every);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping.tick().await;

        loop {
            tokio::select! {
                packet = self.next_packet() => {
                    let Some(packet) = packet? else {
                        return Ok(None);
                    };
                    let (packet_type, flags, payload) = decode_packet(&packet)?;
                    match packet_type {
                        3 => return Ok(Some(decode_publish(flags, payload)?)),
                        13 => {}
                        14 => return Ok(None),
                        other => tracing::debug!("忽略 MQTT 包 type={other}"),
                    }
                }
                _ = ping.tick() => {
                    self.write
                        .send(Message::Binary(vec![0xC0, 0x00].into()))
                        .await
                        .context("发送 MQTT PINGREQ 失败")?;
                }
            }
        }
    }

    fn next_packet_id(&mut self) -> u16 {
        let id = self.packet_id;
        self.packet_id = self.packet_id.wrapping_add(1).max(1);
        id
    }

    async fn next_packet(&mut self) -> Result<Option<Vec<u8>>> {
        loop {
            if let Some(packet) = take_one_packet(&mut self.buffer)? {
                return Ok(Some(packet));
            }
            match self.read.next().await {
                Some(Ok(Message::Binary(data))) => self.buffer.extend_from_slice(&data),
                Some(Ok(Message::Ping(payload))) => {
                    self.write
                        .send(Message::Pong(payload))
                        .await
                        .context("回复 WebSocket ping 失败")?;
                }
                Some(Ok(Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => return Ok(None),
                Some(Ok(Message::Text(text))) => self.buffer.extend_from_slice(text.as_bytes()),
                Some(Err(err)) => return Err(err).context("读取 MQTT WebSocket 失败"),
            }
        }
    }
}

#[derive(Default)]
struct ConnackProps {
    server_keep_alive: Option<u16>,
    server_reference: Option<String>,
}

fn redirect_path(path: &str, server_reference: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    let mut parts: Vec<&str> = trimmed.split('/').collect();
    if parts.last().is_some_and(|part| part.contains(':')) {
        if let Some(last) = parts.last_mut() {
            *last = server_reference;
        }
        parts.join("/")
    } else {
        format!("{trimmed}/{server_reference}")
    }
}

fn encode_connect(
    client_id: &str,
    keep_alive: u16,
    auth_method: &str,
    user_properties: &[(&str, &str)],
) -> Vec<u8> {
    let mut props = Vec::new();
    props.push(PROP_AUTH_METHOD);
    write_mqtt_string(&mut props, auth_method);
    for (key, value) in user_properties {
        props.push(PROP_USER_PROPERTY);
        write_mqtt_string(&mut props, key);
        write_mqtt_string(&mut props, value);
    }

    let mut variable = Vec::new();
    write_mqtt_string(&mut variable, "MQTT");
    variable.push(5);
    variable.push(0x02);
    variable.extend_from_slice(&keep_alive.to_be_bytes());
    write_variable_byte_integer(&mut variable, props.len());
    variable.extend_from_slice(&props);
    write_mqtt_string(&mut variable, client_id);

    let mut packet = vec![0x10];
    write_variable_byte_integer(&mut packet, variable.len());
    packet.extend_from_slice(&variable);
    packet
}

fn encode_subscribe(packet_id: u16, topic: &str, user_properties: &[(&str, &str)]) -> Vec<u8> {
    let mut props = Vec::new();
    for (key, value) in user_properties {
        props.push(PROP_USER_PROPERTY);
        write_mqtt_string(&mut props, key);
        write_mqtt_string(&mut props, value);
    }

    let mut variable = Vec::new();
    variable.extend_from_slice(&packet_id.to_be_bytes());
    write_variable_byte_integer(&mut variable, props.len());
    variable.extend_from_slice(&props);
    write_mqtt_string(&mut variable, topic);
    variable.push(0x00);

    let mut packet = vec![0x82];
    write_variable_byte_integer(&mut packet, variable.len());
    packet.extend_from_slice(&variable);
    packet
}

fn decode_packet(packet: &[u8]) -> Result<(u8, u8, &[u8])> {
    anyhow::ensure!(!packet.is_empty(), "空 MQTT 包");
    let packet_type = packet[0] >> 4;
    let flags = packet[0] & 0x0f;
    let (remaining, header_len) = read_variable_byte_integer(&packet[1..])?;
    let payload_start = 1 + header_len;
    anyhow::ensure!(
        packet.len() >= payload_start + remaining,
        "MQTT 包长度不完整"
    );
    Ok((
        packet_type,
        flags,
        &packet[payload_start..payload_start + remaining],
    ))
}

fn decode_publish(flags: u8, payload: &[u8]) -> Result<MqttPublish> {
    anyhow::ensure!(payload.len() >= 2, "PUBLISH 过短");
    let topic_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    anyhow::ensure!(payload.len() >= 2 + topic_len, "PUBLISH topic 不完整");
    let topic =
        String::from_utf8(payload[2..2 + topic_len].to_vec()).context("PUBLISH topic 不是 UTF-8")?;
    let mut offset = 2 + topic_len;
    let qos = (flags >> 1) & 0x03;
    if qos > 0 {
        anyhow::ensure!(payload.len() >= offset + 2, "PUBLISH packet id 缺失");
        offset += 2;
    }
    anyhow::ensure!(payload.len() >= offset, "PUBLISH properties 缺失");
    let (props_len, props_header) = read_variable_byte_integer(&payload[offset..])?;
    offset += props_header;
    anyhow::ensure!(
        payload.len() >= offset + props_len,
        "PUBLISH properties 不完整"
    );
    let user_properties = parse_user_properties(&payload[offset..offset + props_len])?;
    offset += props_len;
    Ok(MqttPublish {
        topic,
        payload: payload[offset..].to_vec(),
        user_properties,
    })
}

fn parse_properties(bytes: &[u8]) -> Result<ConnackProps> {
    if bytes.is_empty() {
        return Ok(ConnackProps::default());
    }
    let (props_len, header_len) = read_variable_byte_integer(bytes)?;
    let props = &bytes[header_len..header_len + props_len.min(bytes.len().saturating_sub(header_len))];
    let mut out = ConnackProps::default();
    let mut i = 0usize;
    while i < props.len() {
        let id = props[i];
        i += 1;
        match id {
            PROP_SERVER_KEEP_ALIVE => {
                anyhow::ensure!(i + 2 <= props.len(), "Server Keep Alive 不完整");
                out.server_keep_alive = Some(u16::from_be_bytes([props[i], props[i + 1]]));
                i += 2;
            }
            PROP_SERVER_REFERENCE => {
                let (value, size) = read_mqtt_string(&props[i..])?;
                out.server_reference = Some(value);
                i += size;
            }
            other => i += skip_property(other, &props[i..])?,
        }
    }
    Ok(out)
}

fn parse_user_properties(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let id = bytes[i];
        i += 1;
        if id == PROP_USER_PROPERTY {
            let (key, key_size) = read_mqtt_string(&bytes[i..])?;
            i += key_size;
            let (value, value_size) = read_mqtt_string(&bytes[i..])?;
            i += value_size;
            out.push((key, value));
        } else {
            i += skip_property(id, &bytes[i..])?;
        }
    }
    Ok(out)
}

fn skip_property(id: u8, rest: &[u8]) -> Result<usize> {
    Ok(match id {
        // byte
        0x01 | 0x17 | 0x19 | 0x24 | 0x25 | 0x28 | 0x29 | 0x2A => {
            anyhow::ensure!(!rest.is_empty(), "属性长度不足");
            1
        }
        // two byte int
        0x13 | 0x21 | 0x22 | 0x23 => {
            anyhow::ensure!(rest.len() >= 2, "属性长度不足");
            2
        }
        // four byte int
        0x02 | 0x11 | 0x18 | 0x27 => {
            anyhow::ensure!(rest.len() >= 4, "属性长度不足");
            4
        }
        // UTF-8 string
        0x03 | 0x08 | 0x12 | 0x15 | 0x1A | 0x1C | 0x1F => {
            let (_, size) = read_mqtt_string(rest)?;
            size
        }
        // binary data
        0x09 | 0x16 => {
            anyhow::ensure!(rest.len() >= 2, "属性长度不足");
            let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
            anyhow::ensure!(rest.len() >= 2 + len, "属性长度不足");
            2 + len
        }
        // varint
        0x0B => {
            let (_, size) = read_variable_byte_integer(rest)?;
            size
        }
        // user property
        0x26 => {
            let (_, key_size) = read_mqtt_string(rest)?;
            let (_, value_size) = read_mqtt_string(&rest[key_size..])?;
            key_size + value_size
        }
        other => bail!("未识别的 MQTT 属性：0x{other:02x}"),
    })
}

fn take_one_packet(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>> {
    if buffer.is_empty() {
        return Ok(None);
    }
    let (remaining, header_len) = match read_variable_byte_integer(&buffer[1..]) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let total = 1 + header_len + remaining;
    if buffer.len() < total {
        return Ok(None);
    }
    Ok(Some(buffer.drain(..total).collect()))
}

fn write_mqtt_string(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn read_mqtt_string(bytes: &[u8]) -> Result<(String, usize)> {
    anyhow::ensure!(bytes.len() >= 2, "MQTT 字符串长度缺失");
    let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    anyhow::ensure!(bytes.len() >= 2 + len, "MQTT 字符串不完整");
    let text = String::from_utf8(bytes[2..2 + len].to_vec()).context("MQTT 字符串不是 UTF-8")?;
    Ok((text, 2 + len))
}

fn write_variable_byte_integer(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut encoded = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            encoded |= 0x80;
        }
        out.push(encoded);
        if value == 0 {
            break;
        }
    }
}

fn read_variable_byte_integer(bytes: &[u8]) -> Result<(usize, usize)> {
    let mut multiplier = 1usize;
    let mut value = 0usize;
    for (index, byte) in bytes.iter().copied().enumerate() {
        value += (byte & 0x7f) as usize * multiplier;
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
        multiplier = multiplier
            .checked_mul(128)
            .context("MQTT remaining length 溢出")?;
        anyhow::ensure!(index < 3, "MQTT remaining length 过长");
    }
    bail!("MQTT remaining length 不完整")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_length_roundtrips_common_sizes() {
        for value in [0usize, 127, 128, 16383, 16384] {
            let mut encoded = Vec::new();
            write_variable_byte_integer(&mut encoded, value);
            let (decoded, size) = read_variable_byte_integer(&encoded).unwrap();
            assert_eq!(decoded, value);
            assert_eq!(size, encoded.len());
        }
    }

    #[test]
    fn connect_packet_starts_with_connect_type() {
        let packet = encode_connect("client", 45, "pass", &[("tmeAppID", "qqmusic")]);
        assert_eq!(packet[0], 0x10);
        assert!(packet.len() > 20);
    }

    #[test]
    fn redirect_path_appends_server_reference() {
        assert_eq!(
            redirect_path("/ws/handshake", "11.1.2.3_100"),
            "/ws/handshake/11.1.2.3_100"
        );
    }
}
