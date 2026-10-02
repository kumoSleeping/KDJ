// IOBluetooth requires a serviced run loop. Each handle, delegate and SDP record
// is owned by one Rust worker; no UI objects or global mutable session state.
#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>
#include <string.h>

static IOBluetoothSDPUUID *serviceUUID(void) {
    uuid_t bytes;
    NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:@"7C45D810-4E7B-4AC6-9B8F-8532744B444A"];
    [uuid getUUIDBytes:bytes];
    return [IOBluetoothSDPUUID uuidWithBytes:bytes length:16];
}
static void pump(void) {
    // The owning worker paces its whole peer sweep. Keep per-channel polling
    // short so idle standby devices do not multiply the active stream's delay.
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.001]];
}
static void failure(char *out, size_t cap, NSString *message) {
    if (cap) snprintf(out, cap, "%s", message.UTF8String ?: "蓝牙操作失败");
}

@interface KDJRFCOMM : NSObject <IOBluetoothRFCOMMChannelDelegate, IOBluetoothDeviceInquiryDelegate>
@property(nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property(nonatomic, strong) IOBluetoothSDPServiceRecord *record;
@property(nonatomic, strong) IOBluetoothUserNotification *notification;
@property(nonatomic, strong) KDJRFCOMM *incoming;
@property(nonatomic, strong) NSMutableData *received;
@property(nonatomic, strong) NSData *writing;
@property(nonatomic, strong) NSMutableDictionary *devices;
@property(nonatomic) BOOL done;
@property(nonatomic) IOReturn result;
@property(nonatomic) BOOL closed;
@property(nonatomic, strong) NSDate *sdpStarted;
@property(nonatomic, strong) IOBluetoothDevice *target;
@property(nonatomic) BOOL openDone;
@end
@implementation KDJRFCOMM
- (instancetype)init {
    if ((self = [super init])) { _received = [NSMutableData data]; _devices = [NSMutableDictionary dictionary]; }
    return self;
}
- (void)remember:(IOBluetoothDevice *)device {
    NSString *address = device.addressString;
    if (address) self.devices[address] = @{@"id": address, @"name": device.name ?: address, @"paired": @([device isPaired])};
}
- (void)deviceInquiryDeviceFound:(IOBluetoothDeviceInquiry *)sender device:(IOBluetoothDevice *)device { [self remember:device]; }
- (void)deviceInquiryComplete:(IOBluetoothDeviceInquiry *)sender error:(IOReturn)error aborted:(BOOL)aborted { self.result = error; self.done = YES; }
- (void)opened:(IOBluetoothUserNotification *)note channel:(IOBluetoothRFCOMMChannel *)channel {
    // Only an OS-bonded, encrypted computer may take over the VJ input.
    if (self.incoming || ![[channel getDevice] isPaired] || [[channel getDevice] getEncryptionMode] == kEncryptionDisabled) {
        [channel closeChannel]; return;
    }
    KDJRFCOMM *peer = [KDJRFCOMM new]; peer.channel = channel;
    [channel setDelegate:peer]; self.incoming = peer;
}
- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)channel data:(void *)bytes length:(size_t)length {
    if (self.received.length + length > 32768) { self.closed = YES; [channel closeChannel]; return; }
    [self.received appendBytes:bytes length:length];
}
- (void)rfcommChannelOpenComplete:(IOBluetoothRFCOMMChannel *)channel status:(IOReturn)status { self.result = status; self.openDone = YES; }
- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)channel { self.closed = YES; }
- (void)rfcommChannelWriteComplete:(IOBluetoothRFCOMMChannel *)channel refcon:(void *)refcon status:(IOReturn)status {
    self.result = status; self.writing = nil;
}
- (void)shutdown {
    [_notification unregister]; _notification = nil;
    [_record removeServiceRecord]; _record = nil;
    [_channel setDelegate:nil]; [_channel closeChannel]; _channel = nil;
    [_incoming shutdown]; _incoming = nil;
    _writing = nil; _closed = YES;
}
- (void)dealloc { [self shutdown]; }
@end

char *kdj_bt_scan(int activeInquiry, char *error, size_t capacity) {
    @autoreleasepool {
        if ([IOBluetoothHostController defaultController].powerState != kBluetoothHCIPowerStateON) {
            failure(error, capacity, @"蓝牙未开启或不可用"); return NULL;
        }
        KDJRFCOMM *sink = [KDJRFCOMM new];
        for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices]) [sink remember:device];
        IOBluetoothDeviceInquiry *inquiry = [IOBluetoothDeviceInquiry inquiryWithDelegate:sink];
        if (!activeInquiry) {
            NSData *json = [NSJSONSerialization dataWithJSONObject:sink.devices.allValues options:0 error:nil];
            return strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
        }
        inquiry.inquiryLength = 6; inquiry.updateNewDeviceNames = YES;
        IOReturn result = [inquiry start];
        if (result != kIOReturnSuccess) { failure(error, capacity, @"蓝牙扫描失败，请检查蓝牙权限"); return NULL; }
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:12];
        while (!sink.done && deadline.timeIntervalSinceNow > 0) pump();
        [inquiry stop]; [inquiry setDelegate:nil];
        if (!sink.done || sink.result != kIOReturnSuccess) { failure(error, capacity, @"蓝牙扫描超时或失败"); return NULL; }
        NSData *json = [NSJSONSerialization dataWithJSONObject:sink.devices.allValues options:0 error:nil];
        return strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void kdj_bt_free_string(char *text) { free(text); }
void *kdj_bt_listen(char *error, size_t capacity) {
    @autoreleasepool {
        if ([IOBluetoothHostController defaultController].powerState != kBluetoothHCIPowerStateON) {
            failure(error, capacity, @"蓝牙未开启或不可用"); return NULL;
        }
        KDJRFCOMM *sink = [KDJRFCOMM new];
        NSDictionary *channel = @{@"DataElementType": @1, @"DataElementSize": @1, @"DataElementValue": @1};
        sink.record = [IOBluetoothSDPServiceRecord publishedServiceRecordWithDictionary:@{
            @"0001 - ServiceClassIDList": @[serviceUUID()],
            @"0004 - ProtocolDescriptorList": @[@[[IOBluetoothSDPUUID uuid16:0x0100]], @[[IOBluetoothSDPUUID uuid16:0x0003], channel]],
            @"0005 - BrowseGroupList": @[[IOBluetoothSDPUUID uuid16:0x1002]],
            @"0100 - ServiceName": @"KDJ Audio Features",
            @"LocalAttributes": @{@"Persistent": @NO}
        }];
        BluetoothRFCOMMChannelID channelID = 0;
        if (!sink.record || [sink.record getRFCOMMChannelID:&channelID] != kIOReturnSuccess) {
            failure(error, capacity, @"发布 KDJ 蓝牙服务失败"); return NULL;
        }
        sink.notification = [IOBluetoothRFCOMMChannel registerForChannelOpenNotifications:sink selector:@selector(opened:channel:)
            withChannelID:channelID direction:kIOBluetoothUserNotificationChannelDirectionIncoming];
        if (!sink.notification) { failure(error, capacity, @"监听 KDJ 蓝牙服务失败"); return NULL; }
        return (__bridge_retained void *)sink;
    }
}
// Connect is advanced asynchronously from the Rust owner so Stop stays bounded.
void *kdj_bt_connect(const char *address, char *error, size_t capacity) {
    @autoreleasepool {
        IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:[NSString stringWithUTF8String:address]];
        if (!device || !device.isPaired) { failure(error, capacity, @"请先在系统蓝牙设置中配对这两台电脑，再开始发送"); return NULL; }
        KDJRFCOMM *sink = [KDJRFCOMM new];
        sink.target = device; sink.sdpStarted = [NSDate date];
        // A nil query target avoids an outstanding delegate after Stop. Poll
        // the documented service-update timestamp on this worker's run loop.
        IOReturn result = [device performSDPQuery:nil uuids:@[serviceUUID()]];
        if (result != kIOReturnSuccess) { failure(error, capacity, @"查询 KDJ 蓝牙服务失败"); return NULL; }
        return (__bridge_retained void *)sink;
    }
}
int kdj_bt_connect_poll(void *handle, char *error, size_t capacity) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle; pump();
        NSDate *updated = [sink.target getLastServicesUpdate];
        if (!updated || [updated compare:sink.sdpStarted] == NSOrderedAscending) return 0;
        if (sink.result != kIOReturnSuccess) { failure(error, capacity, @"蓝牙连接失败，请确认对方已启动实时 VJ"); return -1; }
        if (!sink.channel) {
            IOBluetoothDevice *device = sink.target;
            IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:serviceUUID()];
            BluetoothRFCOMMChannelID channelID = 0;
            if (!record || [record getRFCOMMChannelID:&channelID] != kIOReturnSuccess) {
                failure(error, capacity, @"对方未发布 KDJ 服务，请先启动实时 VJ"); return -1;
            }
            IOBluetoothRFCOMMChannel *channel = nil;
            IOReturn result = [device openRFCOMMChannelAsync:&channel withChannelID:channelID delegate:sink];
            sink.channel = channel;
            if (result != kIOReturnSuccess) { failure(error, capacity, @"打开 RFCOMM 连接失败"); return -1; }
            // The SDK explicitly returns a retained channel through this out
            // parameter, which is not annotated for ARC. Balance that +1;
            // sink.channel now owns our normal strong reference.
            if (channel) CFRelease((__bridge CFTypeRef)channel);
        }
        if (!sink.openDone) return 0;
        if (sink.closed || sink.result != kIOReturnSuccess || [[sink.channel getDevice] getEncryptionMode] == kEncryptionDisabled) {
            failure(error, capacity, @"蓝牙连接未建立加密，请重新进行系统配对"); return -1;
        }
        return 1;
    }
}
int kdj_bt_listening(void *handle) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle;
        return sink.record && sink.notification && [IOBluetoothHostController defaultController].powerState == kBluetoothHCIPowerStateON;
    }
}
void *kdj_bt_accept(void *handle, char *peer, size_t capacity) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle; pump();
        KDJRFCOMM *incoming = sink.incoming;
        if (!incoming) return NULL;
        sink.incoming = nil;
        failure(peer, capacity, [incoming.channel getDevice].addressString);
        return (__bridge_retained void *)incoming;
    }
}
int kdj_bt_read(void *handle, void *bytes, size_t capacity) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle; pump();
        if (sink.closed || !sink.channel.isOpen) return -1;
        NSUInteger length = MIN(capacity, sink.received.length);
        if (length) { memcpy(bytes, sink.received.bytes, length); [sink.received replaceBytesInRange:NSMakeRange(0, length) withBytes:NULL length:0]; }
        return (int)length;
    }
}
int kdj_bt_write(void *handle, const void *bytes, size_t length) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle; pump();
        if (sink.closed || !sink.channel.isOpen || sink.result != kIOReturnSuccess) return -1;
        if (sink.writing) return 0;
        size_t count = MIN(length, [sink.channel getMTU]);
        if (!count) return -1;
        sink.writing = [NSData dataWithBytes:bytes length:count];
        IOReturn result = [sink.channel writeAsync:(void *)sink.writing.bytes length:(UInt16)count refcon:NULL];
        if (result != kIOReturnSuccess) { sink.writing = nil; sink.result = result; return -1; }
        return (int)count;
    }
}
int kdj_bt_flushed(void *handle) {
    @autoreleasepool {
        KDJRFCOMM *sink = (__bridge KDJRFCOMM *)handle; pump();
        if (sink.closed || sink.result != kIOReturnSuccess) return -1;
        return sink.writing ? 0 : 1;
    }
}
void kdj_bt_close(void *handle) {
    @autoreleasepool { KDJRFCOMM *sink = (__bridge_transfer KDJRFCOMM *)handle; [sink shutdown]; }
}
