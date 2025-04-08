// platform.ts
import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  CharacteristicValue
} from 'homebridge';

import { Config, Device, DeviceStatus } from './lib/Config';
import { SmarteefiAPIHelper } from './lib/SmarteefiAPIHelper';
import { SwitchAccessory } from './lib/accessories/SwitchAccessory';
import { FanAccessory } from './lib/accessories/FanAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './constants';
import * as SmarteefiHelper from './lib/SmarteefiHelper';

interface DeviceConfigEntry {
  device: string;
  name?: string;
  ip?: string;
  isFan?: boolean;
}


export class SmarteefiPlatform implements DynamicPlatformPlugin {
public readonly Service: typeof Service = this.api.hap.Service;
public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

public readonly accessories: PlatformAccessory[] = [];
public readonly apiHelper!: SmarteefiAPIHelper;

private refreshDelay = 60000;
private deviceStatus: DeviceStatus = DeviceStatus.Instance();
private refreshInterval: NodeJS.Timeout | null = null;
private platformReady = false;


constructor(
  public readonly log: Logger,
  public readonly config: PlatformConfig,
  public readonly api: API,
) {
  this.log.debug('Finished initializing platform:', this.config.name);

  if (!this.config.userid || !this.config.password) {
    this.log.error("CRITICAL: Missing 'userid' or 'password' in Homebridge config.json. Smarteefi plugin will not function.");
  } else {
    try {
      const parsedConfig = new Config(
          this.config.userid as string,
          this.config.password as string,
          this.config.devices as object[],
          !!this.config.local
      );
      this.apiHelper = SmarteefiAPIHelper.Instance(parsedConfig, this.log);
    } catch (error) {
         const msg = error instanceof Error ? error.message : String(error);
         this.log.error(`CRITICAL: Failed to initialize Smarteefi Config/API Helper: ${msg}. Plugin will not function.`);
    }
  }

  this.refreshDelay = this.config.refreshDelay || 60000;

  this.api.on('didFinishLaunching', () => {
    this.log.debug('Executed didFinishLaunching callback');
    this.platformReady = true;
    if (!this.apiHelper) {
        this.log.error("Smarteefi API Helper not initialized (check previous errors). Skipping device discovery.");
        return;
    }
    this.discoverDevices();
  });
}

configureAccessory(accessory: PlatformAccessory) {
  this.log.info('Loading accessory from cache:', accessory.displayName);
  this.accessories.push(accessory);
}

discoverDevices() {
   if (!this.apiHelper) {
      this.log.error("Cannot discover devices: API Helper not available.");
      return;
   }
   // ** FIX 1: Check the platform's config directly **
   if (!this.config.devices || this.config.devices.length === 0) {
      return this.log.error("No devices configured in config.json. Cannot start discovery.");
   }

  this.log.info('Starting discovery process using SmarteefiAPIHelper...');

  this.apiHelper.login(async (token) => {
      if (!token) {
          this.log.error("Initial login failed. Cannot discover devices.");
          return;
      }
      this.log.info("Login successful, fetching devices from API Helper...");
      try {
           // ** FIX 3: Ensure call only passes the callback **
           this.apiHelper.fetchDevices((devices: Device[]) => {
               this.log.info(`Discovered ${devices.length} potential accessories from API.`);
               this.registerDiscoveredDevices(devices);
               this.refreshStatus(); // Perform one immediate refresh
               this.setupPeriodicRefresh();
           });
      } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.log.error(`Error during API Helper fetchDevices: ${msg}`);
      }
  });
}

registerDiscoveredDevices(devices: Device[]) {
    const currentAccessoryUUIDs = new Set<string>();
    for (const device of devices) {
        if (!device || !device.id || !device.name) {
            this.log.warn('Skipping invalid device data received from API helper.');
            continue;
        }
        const uuid = this.api.hap.uuid.generate(device.id + "" + (device.sequence ?? ''));
        currentAccessoryUUIDs.add(uuid);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingAccessory) {
            this.log.info('Updating existing accessory:', device.name);
            existingAccessory.context.device = device;
            this.api.updatePlatformAccessories([existingAccessory]);
            try {
                if (device.isFan) new FanAccessory(this, existingAccessory);
                else new SwitchAccessory(this, existingAccessory);
            } catch (initError) { this.log.error(`Error updating handler for ${existingAccessory.displayName}: ${initError}`); }
        } else {
            this.log.info('Adding new accessory:', device.name);
            const accessory = new this.api.platformAccessory(device.name, uuid);
            accessory.context.device = device;
            try {
                if (device.isFan) new FanAccessory(this, accessory);
                else new SwitchAccessory(this, accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                this.accessories.push(accessory);
            } catch (initError) { this.log.error(`Error initializing handler for new accessory ${device.name}: ${initError}`); }
        }
    }
    // Optional: Unregister orphaned accessories
    // this.unregisterOrphanedAccessories(currentAccessoryUUIDs);
}

setupPeriodicRefresh() {
      if (!this.apiHelper || this.refreshDelay <= 0) {
          this.log.info('Periodic refresh disabled (no API helper or delay <= 0).');
          return;
      }
      this.log.debug(`Setting up periodic refresh every ${this.refreshDelay} ms.`);
      if (this.refreshInterval) {
          clearInterval(this.refreshInterval);
          this.refreshInterval = null;
      }
      this.refreshInterval = setInterval(() => this.refreshStatus(), this.refreshDelay);
 }

/**
 * Refreshes the status of all configured devices periodically.
 * Removed unused 'onetime' parameter.
 */
refreshStatus() {
   if (!this.apiHelper) {
      this.log.error("Cannot refresh status: API Helper not available.");
      return;
   }
  const configuredDeviceGroups = this.config.devices as DeviceConfigEntry[] || [];
  if (configuredDeviceGroups.length === 0) {
      this.log.debug('Refresh skipped: No devices configured.');
      return;
  }
  const totalConfiguredDeviceGroups = configuredDeviceGroups.length;

  this.log.info(`Starting status refresh for ${totalConfiguredDeviceGroups} configured device groups...`);
  const apiHelper = this.apiHelper;

  if (!apiHelper.isLoggedIn()) {
      this.log.warn('API Helper not logged in, attempting login before refresh...');
      if (!apiHelper.login) { this.log.error("API Helper is not functional. Skipping refresh."); return; }
      apiHelper.login((token) => {
          if (token) { this.log.info('Login successful, proceeding with refresh.'); this.executeRefreshCycle(apiHelper); }
          else { this.log.error('Login failed during refresh attempt. Skipping refresh cycle.'); }
      });
  } else {
      this.executeRefreshCycle(apiHelper);
  }
}

/**
 * Helper method to perform the actual refresh API calls for each configured device group.
 */
private executeRefreshCycle(apiHelper: SmarteefiAPIHelper) {
    let completedUpdates = 0;
    const configuredDeviceGroups = this.config.devices as DeviceConfigEntry[] || [];
    const totalConfiguredDeviceGroups = configuredDeviceGroups.length;
    if (totalConfiguredDeviceGroups === 0) return;

    this.log.debug(`Executing refresh cycle...`);

    for (const deviceConfig of configuredDeviceGroups) {
        const deviceId = deviceConfig?.device;
        if (!deviceId) {
            this.log.warn(`Skipping device config entry: missing 'device' ID.`);
            completedUpdates++;
            if (completedUpdates >= totalConfiguredDeviceGroups) this.log.info("Status refresh cycle completed (with skips).");
            continue;
        }
        if (!apiHelper.getSwitchStatus) {
             this.log.error(`API Helper is missing getSwitchStatus method. Skipping refresh for ${deviceId}`);
             completedUpdates++;
             if (completedUpdates >= totalConfiguredDeviceGroups) this.log.info("Status refresh cycle completed (with errors).");
             continue;
        }

        // Use 'this' directly inside arrow function callback
        apiHelper.getSwitchStatus(deviceId, 255, (body) => {
            try {
                if (!body || typeof body !== 'object' || body.result === "error" || body.result === "failure") {
                    const reason = SmarteefiHelper.getReason(body?.major_ecode) || body?.reason || 'Unknown error or empty body';
                    this.log.error(`Unable to get status for deviceId ${deviceId}. Reason: ${reason}`);
                    this.deviceStatus.setStatusMap(deviceId, -1, -1);
                } else {
                    const switchmap = typeof body.switchmap === 'number' ? body.switchmap : 0;
                    const statusmap = typeof body.statusmap === 'number' ? body.statusmap : 0;
                    this.log.debug(`Received status for ${deviceId}: switchmap=${switchmap}, statusmap=${statusmap}`);
                    this.deviceStatus.setStatusMap(deviceId, switchmap, statusmap);

                    for (const acc of this.accessories) {
                         if (acc.context?.device?.id === deviceId) {
                            const deviceContext = acc.context.device;
                            const isFan = !!deviceContext.isFan;
                            const sequence = typeof deviceContext.sequence === 'number' ? deviceContext.sequence : -1;
                            if (sequence === -1) continue;

                            const service = isFan ? acc.getService(this.Service.Fanv2) : acc.getService(this.Service.Switch);
                            if (service) {
                                try {
                                  const onOffState = this.decodeStatus(sequence, deviceId);
                                  const onOffCharacteristic = isFan ? this.Characteristic.Active : this.Characteristic.On;
                                  if(service.testCharacteristic(onOffCharacteristic)) {
                                      service.updateCharacteristic(onOffCharacteristic, onOffState);
                                      this.log.debug(`Refreshed '${acc.displayName}' (${onOffCharacteristic.name}) to ${onOffState}`);
                                  }
                                  if (isFan) {
                                      const speedState = SmarteefiHelper.getSpeedFromStatusMap(statusmap, SmarteefiHelper.getSwitchMap(sequence));
                                       if(service.testCharacteristic(this.Characteristic.RotationSpeed)) {
                                          service.updateCharacteristic(this.Characteristic.RotationSpeed, speedState);
                                          this.log.debug(`Refreshed '${acc.displayName}' (RotationSpeed) to ${speedState}%`);
                                       }
                                  }
                                } catch (decodeError) { this.log.error(`Error decoding/updating status for ${acc.displayName}: ${decodeError}`); }
                            }
                        }
                    }
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.log.error(`Error processing status update for ${deviceId}: ${msg}`);
                 this.deviceStatus.setStatusMap(deviceId, -1, -1);
            } finally {
                completedUpdates++;
                if (completedUpdates >= totalConfiguredDeviceGroups) {
                    this.log.info("Status refresh cycle completed.");
                }
            }
        });
    }
}

decodeStatus(sequence: number, deviceId: string): CharacteristicValue {
  return SmarteefiHelper.decodeStatus(sequence, deviceId, this.Characteristic, this.deviceStatus);
}

 shutdown() {
   if (this.refreshInterval) {
     clearInterval(this.refreshInterval);
     this.log.info('Cleared status refresh interval on shutdown.');
   }
 }
}