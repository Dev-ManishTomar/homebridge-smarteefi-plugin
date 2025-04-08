// src/lib/Config.ts (Restore original method names)

export class Config {
    // ... constructor and properties remain the same ...
    public userid = "";
    public password = "";
    public devices: string[] = [];
    public ip: string[] = [];
    public isFan: boolean[] = [];
    public local = false;
    constructor(userid?: string, password?: string, devicesConfig?: object[], local?: boolean) {
        this.userid = userid || "";
        this.password = password || "";
        this.devices = [];
        this.ip = [];
        this.isFan = [];

        devicesConfig?.forEach((deviceEntry: object) => {
            const deviceId = deviceEntry["device"] as string;
            const ipAddress = deviceEntry["ip"] as string;
            const fanFlag = !!deviceEntry["isFan"];
            if (deviceId) {
                this.devices.push(deviceId);
                this.ip.push(ipAddress || '');
                this.isFan.push(fanFlag);
            }
        });
        this.local = !!local;
    }
}

export class Device {
    // ... remains the same ...
    public id = "";
    public sequence = 0;
    public name = "Unknown";
    public ip: string | null = null;
    public isFan = false;
    constructor(id: string, sequence: number, name: string, ip: string | null, isFan: boolean) {
        this.id = id;
        this.sequence = sequence;
        this.name = name;
        this.ip = ip;
        this.isFan = isFan;
    }
}

export class IP { // Keep if used, otherwise remove
    // ... remains the same ...
    public id = "";
    public name = "Unknown";
    public sequence = 0;
    public ip: string | null = null;
    constructor(id: string, sequence: number, name: string) {
        this.id = id;
        this.sequence = sequence;
        this.name = name;
    }
}

export class Status {
    // ... remains the same (with speedValue) ...
    public id = "";
    public switchmap = 255;
    public statusmap = 0;
    public speedValue: number | null = null; // Store speed 1-4 for fans

    constructor(id: string, switchmap: number, statusmap: number, speedValue: number | null = null) {
        this.id = id;
        this.switchmap = switchmap;
        this.statusmap = statusmap;
        this.speedValue = speedValue;
    }
}

export class DeviceStatus {
    public statuses: Status[] = [];
    private static _instance: DeviceStatus;

    /**
     * Gets the full Status object for a given device ID.
     * Retains original method name.
     */
    getStatusMap(id: string): Status | undefined { // Changed return type
        // Find and return the whole Status object or undefined
        return this.statuses.find(value => value.id === id);
    }

    /**
     * Sets or updates the status for a device ID.
     * Retains original method name, adds optional speedValue.
     */
    setStatusMap(id: string, switchmap: number, statusmap: number, speedValue?: number | null): void { // Added optional speedValue
        let statusObj = this.getStatusMap(id); // Use the corrected getStatusMap
        if (!statusObj) {
            // If speedValue is undefined here, default it to null for a new entry
            statusObj = new Status(id, switchmap, statusmap, speedValue === undefined ? null : speedValue);
            this.statuses.push(statusObj);
        } else {
            statusObj.switchmap = switchmap;
            statusObj.statusmap = statusmap;
            // Only update speed if a value (including null) was explicitly passed
            if (speedValue !== undefined) {
                 statusObj.speedValue = speedValue;
            }
            // If the primary statusmap indicates OFF, ensure speed is cleared
            // (Assuming statusmap 0 from getSwitchStatus reliably means OFF)
            if (statusmap === 0 && statusObj.speedValue !== null) {
                 statusObj.speedValue = null;
            }
        }
    }

    // Keep Instance method
    public static Instance(): DeviceStatus {
        const c = this._instance || (this._instance = new this());
        return c;
    }
}