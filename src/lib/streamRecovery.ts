/** Error text is only a compatibility boundary for native adapters, never authoritative playback state. */
export function streamRecoveryPolicy(error: string): { retry: boolean; invalidateCache: boolean } {
  // These failures need user action or a device recovery, not another provider request.
  if (/AUTH_EXPIRED|RATE_LIMITED|ACCOUNT_CHANGED|MEDIA_UNAVAILABLE|HTTP\s*(?:401|403|429)|凭证.*(?:过期|失效)|登录.*(?:过期|失效)|重新扫码|频繁|限流|device|设备|声卡|输出设备|permission|权限/i.test(error)) {
    return { retry: false, invalidateCache: false };
  }
  const decode = /decode|decoding|解码|invalid.*(?:audio|media)|不是.*音频|缓存.*损坏/i.test(error);
  return {
    retry: decode || /MEDIA_ENTITY_CHANGED|online audio|试听|HTTP\s*(?:404|410|409|5\d\d)|network|连接|超时|读取|EOF|中断|Range/i.test(error),
    invalidateCache: decode,
  };
}
