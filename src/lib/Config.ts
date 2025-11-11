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
    public preservedSpeedValue: number | null = null; // Last non-zero speed to restore on ON
    public preservedAtOff: number | null = null; // Snapshot of speed at OFF time for next ON restore
    public lastCommandTimestamp = 0; // Track last user command
    public pendingUpdate = false; // Prevent refresh conflicts
    public previousState?: { // For rollback on failure
        statusmap: number;
        speedValue: number | null;
    };

    constructor(id: string, switchmap: number, statusmap: number, speedValue: number | null = null) {
        this.id = id;
        this.switchmap = switchmap;
        this.statusmap = statusmap;
        this.speedValue = speedValue;
        this.preservedSpeedValue = null;
        this.preservedAtOff = null;
        this.lastCommandTimestamp = 0;
        this.pendingUpdate = false;
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
            // DON'T clear speedValue when statusmap is 0 - preserve last known speed
            // This allows restoring the speed when turning the fan back ON
        }
    }

    /**
     * Set or update the preservedSpeedValue (last non-zero speed for restore).
     */
    setPreservedSpeedValue(id: string, preserved: number | null): void {
        const statusObj = this.getStatusMap(id);
        if (statusObj) {
            statusObj.preservedSpeedValue = preserved;
        }
    }

    /**
     * Get the preservedSpeedValue for a device (may be null).
     */
    getPreservedSpeedValue(id: string): number | null {
        const statusObj = this.getStatusMap(id);
        return statusObj ? (statusObj.preservedSpeedValue ?? null) : null;
    }

    /**
     * Set a snapshot to restore exactly on the next ON after an OFF.
     */
    setPreservedAtOff(id: string, preserved: number | null): void {
        const statusObj = this.getStatusMap(id);
        if (statusObj) {
            statusObj.preservedAtOff = preserved;
        }
    }

    /**
     * Get the OFF snapshot value if present.
     */
    getPreservedAtOff(id: string): number | null {
        const statusObj = this.getStatusMap(id);
        return statusObj ? (statusObj.preservedAtOff ?? null) : null;
    }

    /**
     * Mark that a command is in progress for a device to prevent refresh conflicts
     */
    markCommandInProgress(id: string): void {
        const statusObj = this.getStatusMap(id);
        if (statusObj) {
            statusObj.pendingUpdate = true;
            statusObj.lastCommandTimestamp = Date.now();
        }
    }

    /**
     * Mark that a command is complete for a device
     */
    markCommandComplete(id: string): void {
        const statusObj = this.getStatusMap(id);
        if (statusObj) {
            statusObj.pendingUpdate = false;
        }
    }

    /**
     * Check if a refresh update should be skipped due to a recent command
     */
    shouldSkipRefreshUpdate(id: string, graceMs: number): boolean {
        const statusObj = this.getStatusMap(id);
        if (!statusObj) {
            return false;
        }
        
        // Skip if update is pending
        if (statusObj.pendingUpdate) {
            return true;
        }
        
        // Skip if command was recent
        const timeSinceCommand = Date.now() - statusObj.lastCommandTimestamp;
        return timeSinceCommand < graceMs;
    }

    /**
     * Save the current state for potential rollback
     */
    saveRollbackState(id: string): void {
        const statusObj = this.getStatusMap(id);
        if (statusObj) {
            statusObj.previousState = {
                statusmap: statusObj.statusmap,
                speedValue: statusObj.speedValue,
            };
        }
    }

    /**
     * Rollback to the previous state if API call failed
     */
    rollbackState(id: string): boolean {
        const statusObj = this.getStatusMap(id);
        if (statusObj && statusObj.previousState) {
            statusObj.statusmap = statusObj.previousState.statusmap;
            statusObj.speedValue = statusObj.previousState.speedValue;
            statusObj.previousState = undefined;
            return true;
        }
        return false;
    }

    // Keep Instance method
    public static Instance(): DeviceStatus {
        const c = this._instance || (this._instance = new this());
        return c;
    }
}