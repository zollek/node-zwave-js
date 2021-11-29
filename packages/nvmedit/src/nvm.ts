import {
	compressObjects,
	fragmentLargeObject,
	NVM3_OBJ_HEADER_SIZE_SMALL,
	NVM3_WORD_SIZE,
	NVMObject,
	NVM_COUNTER_SIZE,
	ObjectType,
	writeObject,
} from "./object";
import {
	FLASH_MAX_PAGE_SIZE,
	NVM3_PAGE_HEADER_SIZE,
	NVMPage,
	PageStatus,
	PageWriteSize,
	readPage,
	writePageHeader,
} from "./page";
import { dumpObject, dumpPage } from "./utils";

const ZWAVE_APPLICATION_NVM_SIZE = 0x3000;
const ZWAVE_PROTOCOL_NVM_SIZE = 0xc000 - ZWAVE_APPLICATION_NVM_SIZE;

function comparePages(p1: NVMPage, p2: NVMPage) {
	if (p1.header.eraseCount === p2.header.eraseCount) {
		return p1.header.offset - p2.header.offset;
	} else {
		return p1.header.eraseCount - p2.header.eraseCount;
	}
}

export function parseNVM(
	buffer: Buffer,
	verbose: boolean = false,
): {
	/** All application pages in the NVM */
	applicationPages: NVMPage[];
	/** All application pages in the NVM */
	protocolPages: NVMPage[];
	/** A compressed map of application-level NVM objects */
	applicationObjects: Map<number, NVMObject>;
	/** A compressed map of protocol-level NVM objects */
	protocolObjects: Map<number, NVMObject>;
} {
	let offset = 0;
	const pages: NVMPage[] = [];
	while (offset < buffer.length) {
		const { page, bytesRead } = readPage(buffer, offset);
		if (verbose) dumpPage(page);
		pages.push(page);
		offset += bytesRead;
	}

	const applicationPages = pages.filter(
		(p) => p.header.offset < ZWAVE_APPLICATION_NVM_SIZE,
	);
	const protocolPages = pages.filter(
		(p) => p.header.offset >= ZWAVE_APPLICATION_NVM_SIZE,
	);

	// The pages are written in a ring buffer, find the one with the lowest erase count and start reading from there in order
	applicationPages.sort(comparePages);
	protocolPages.sort(comparePages);

	// Build a compressed view of the NVM objects
	const applicationObjects = compressObjects(
		applicationPages.reduce(
			(acc, page) => acc.concat(page.objects),
			[] as NVMObject[],
		),
	);

	const protocolObjects = compressObjects(
		protocolPages.reduce(
			(acc, page) => acc.concat(page.objects),
			[] as NVMObject[],
		),
	);

	if (verbose) {
		console.log();
		console.log();
		console.log("Application objects:");
		applicationObjects.forEach((obj) => dumpObject(obj, true));
		console.log();
		console.log("Protocol objects:");
		protocolObjects.forEach((obj) => dumpObject(obj, true));
	}

	return {
		applicationPages,
		protocolPages,
		applicationObjects,
		protocolObjects,
	};
}

export interface EncodeNVMOptions {
	pageSize?: number;
	deviceFamily?: number;
	writeSize?: PageWriteSize;
	memoryMapped?: boolean;
}

export function encodeNVM(
	/** A compressed map of application-level NVM objects */
	applicationObjects: Map<number, NVMObject>,
	/** A compressed map of protocol-level NVM objects */
	protocolObjects: Map<number, NVMObject>,
	options?: EncodeNVMOptions,
): Buffer {
	const {
		pageSize = FLASH_MAX_PAGE_SIZE,
		deviceFamily = 2047,
		writeSize = PageWriteSize.WRITE_SIZE_16,
		memoryMapped = true,
	} = options ?? {};

	const createEmptyPage = (): Buffer => {
		const ret = Buffer.alloc(pageSize, 0xff);
		writePageHeader({
			version: 0x01,
			eraseCount: 0,
			encrypted: false,
			deviceFamily,
			memoryMapped,
			pageSize,
			status: PageStatus.OK,
			writeSize,
		}).copy(ret, 0);
		return ret;
	};

	const applicationPages: Buffer[] = [];
	for (let i = 0; i < ZWAVE_APPLICATION_NVM_SIZE / pageSize; i++) {
		applicationPages.push(createEmptyPage());
	}

	const protocolPages: Buffer[] = [];
	for (let i = 0; i < ZWAVE_PROTOCOL_NVM_SIZE / pageSize; i++) {
		protocolPages.push(createEmptyPage());
	}

	const writeObjects = (pages: Buffer[], objects: Map<number, NVMObject>) => {
		// Keep track where we are at with writing in the pages
		let pageIndex = -1;
		let offsetInPage = -1;
		let remainingSpace = -1;
		let currentPage!: Buffer;
		const nextPage = () => {
			pageIndex++;
			if (pageIndex >= pages.length) {
				throw new Error("Not enough pages!");
			}
			currentPage = pages[pageIndex];
			offsetInPage = NVM3_PAGE_HEADER_SIZE;
			remainingSpace = pageSize - offsetInPage;
		};
		const incrementOffset = (by: number) => {
			const alignedDelta =
				(by + NVM3_WORD_SIZE - 1) & ~(NVM3_WORD_SIZE - 1);

			offsetInPage += alignedDelta;
			remainingSpace = pageSize - offsetInPage;
		};

		nextPage();
		for (const obj of objects.values()) {
			let fragments: NVMObject[] | undefined;

			if (obj.type === ObjectType.Deleted) continue;
			if (
				(obj.type === ObjectType.CounterSmall &&
					remainingSpace <
						NVM3_OBJ_HEADER_SIZE_SMALL + NVM_COUNTER_SIZE) ||
				(obj.type === ObjectType.DataSmall &&
					remainingSpace <
						NVM3_OBJ_HEADER_SIZE_SMALL + (obj.data?.length ?? 0))
			) {
				// Small objects cannot be fragmented and need to go on the next page
				nextPage();
			} else if (
				obj.type === ObjectType.CounterLarge ||
				obj.type === ObjectType.DataLarge
			) {
				// Large objects may be fragmented
				fragments = fragmentLargeObject(
					obj as any,
					remainingSpace,
					pageSize - NVM3_PAGE_HEADER_SIZE,
				);
			}
			if (!fragments) fragments = [obj];

			for (const fragment of fragments) {
				const objBuffer = writeObject(fragment);
				objBuffer.copy(currentPage, offsetInPage);
				incrementOffset(objBuffer.length);

				// Each following fragment needs to be written to a different page^
				if (fragments.length > 1) nextPage();
			}
		}
	};

	writeObjects(applicationPages, applicationObjects);
	writeObjects(protocolPages, protocolObjects);

	return Buffer.concat([...applicationPages, ...protocolPages]);
}
