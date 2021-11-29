import { NVMObject, readObjects } from "./object";
import { computeBergerCode, validateBergerCode } from "./utils";

const NVM3_MIN_PAGE_SIZE = 512;
export const FLASH_MAX_PAGE_SIZE = 2048;
export const NVM3_PAGE_HEADER_SIZE = 20;
const NVM3_PAGE_COUNTER_SIZE = 27;
const NVM3_PAGE_COUNTER_MASK = (1 << NVM3_PAGE_COUNTER_SIZE) - 1;
const NVM3_PAGE_MAGIC = 0xb29a;

export enum NVMVersion {
	"7.0+",
	"7.11+",
	"7.15.3+",
}

export interface PageHeader {
	offset: number;
	version: number;
	eraseCount: number;
	status: PageStatus;
	encrypted: boolean;
	pageSize: number;
	writeSize: PageWriteSize;
	memoryMapped: boolean;
	deviceFamily: number;
}

export enum PageStatus {
	OK = 0xffffffff,
	OK_ErasePending = 0xffffa5a5,
	Bad = 0x0000ffff,
	Bad_ErasePending = 0x0000a5a5,
}

export interface NVMPage {
	header: PageHeader;
	objects: NVMObject[];
}

export enum PageWriteSize {
	WRITE_SIZE_32 = 0, // Only single writes are allowed
	WRITE_SIZE_16 = 1, // Two writes are allowed
}

// The page size field has a value from 0 to 7 describing page sizes from 512 to 65536 bytes
export function pageSizeToBits(pageSize: number): number {
	return Math.ceil(Math.log2(pageSize) - Math.log2(NVM3_MIN_PAGE_SIZE));
}

export function pageSizeFromBits(bits: number): number {
	return NVM3_MIN_PAGE_SIZE * Math.pow(2, bits);
}

export function readPage(
	buffer: Buffer,
	offset: number,
): { page: NVMPage; bytesRead: number } {
	const version = buffer.readUInt16LE(offset);
	const magic = buffer.readUInt16LE(offset + 2);
	if (magic !== NVM3_PAGE_MAGIC) {
		throw new Error("Not a valid NVM3 page!");
	}
	if (version !== 0x01) {
		throw new Error(`Unsupported NVM3 page version: ${version}`);
	}

	// The erase counter is saved twice, once normally, once inverted
	let eraseCount = buffer.readUInt32LE(offset + 4);
	const eraseCountCode = eraseCount >>> NVM3_PAGE_COUNTER_SIZE;
	eraseCount &= NVM3_PAGE_COUNTER_MASK;
	validateBergerCode(eraseCount, eraseCountCode, NVM3_PAGE_COUNTER_SIZE);

	let eraseCountInv = buffer.readUInt32LE(offset + 8);
	const eraseCountInvCode = eraseCountInv >>> NVM3_PAGE_COUNTER_SIZE;
	eraseCountInv &= NVM3_PAGE_COUNTER_MASK;
	validateBergerCode(
		eraseCountInv,
		eraseCountInvCode,
		NVM3_PAGE_COUNTER_SIZE,
	);

	if (eraseCount !== (~eraseCountInv & NVM3_PAGE_COUNTER_MASK)) {
		throw new Error("Invalid erase count!");
	}

	// Page status
	const status = buffer.readUInt32LE(offset + 12);

	const devInfo = buffer.readUInt16LE(offset + 16);
	const deviceFamily = devInfo & 0x7ff;
	const writeSize = (devInfo >> 11) & 0b1;
	const memoryMapped = !!((devInfo >> 12) & 0b1);
	const pageSize = pageSizeFromBits((devInfo >> 13) & 0b111);

	// Application NVM pages seem to get written with a page size of 0xffff
	const actualPageSize = Math.min(pageSize, FLASH_MAX_PAGE_SIZE);

	if (buffer.length < offset + actualPageSize) {
		throw new Error("Incomplete page in buffer!");
	}

	const formatInfo = buffer.readUInt16LE(offset + 18);

	const encrypted = !(formatInfo & 0b1);

	const header: PageHeader = {
		offset,
		version,
		eraseCount,
		status,
		encrypted,
		pageSize,
		writeSize,
		memoryMapped,
		deviceFamily,
	};
	const bytesRead = actualPageSize;
	const data = buffer.slice(offset + 20, offset + bytesRead);

	const { objects } = readObjects(data);

	return {
		page: { header, objects },
		bytesRead,
	};
}

export function writePageHeader(header: Omit<PageHeader, "offset">): Buffer {
	const ret = Buffer.alloc(NVM3_PAGE_HEADER_SIZE);

	ret.writeUInt16LE(header.version, 0);
	ret.writeUInt16LE(NVM3_PAGE_MAGIC, 2);

	let eraseCount = header.eraseCount & NVM3_PAGE_COUNTER_MASK;
	const eraseCountCode = computeBergerCode(
		eraseCount,
		NVM3_PAGE_COUNTER_SIZE,
	);
	eraseCount |= eraseCountCode << NVM3_PAGE_COUNTER_SIZE;
	ret.writeInt32LE(eraseCount, 4);

	let eraseCountInv = ~header.eraseCount & NVM3_PAGE_COUNTER_MASK;
	const eraseCountInvCode = computeBergerCode(
		eraseCountInv,
		NVM3_PAGE_COUNTER_SIZE,
	);
	eraseCountInv |= eraseCountInvCode << NVM3_PAGE_COUNTER_SIZE;
	ret.writeInt32LE(eraseCountInv, 8);

	ret.writeUInt32LE(header.status, 12);

	const devInfo =
		(header.deviceFamily & 0x7ff) |
		((header.writeSize & 0b1) << 11) |
		((header.memoryMapped ? 1 : 0) << 12) |
		(pageSizeToBits(header.pageSize) << 13);
	ret.writeUInt16LE(devInfo, 16);

	const formatInfo = header.encrypted ? 0xfffe : 0xffff;
	ret.writeUInt16LE(formatInfo, 18);

	return ret;
}
