#![no_std]

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;

unsafe extern "C" {
    fn abort() -> !;
    fn aligned_alloc(alignment: usize, size: usize) -> *mut c_void;
    fn free(pointer: *mut c_void);
    fn malloc(size: usize) -> *mut c_void;
    fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
}

struct LibcAllocator;

unsafe impl GlobalAlloc for LibcAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= 16 {
            malloc(layout.size()).cast()
        } else {
            aligned_alloc(layout.align(), layout.size()).cast()
        }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        free(pointer.cast());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if layout.align() <= 16 {
            realloc(pointer.cast(), new_size).cast()
        } else {
            core::ptr::null_mut()
        }
    }
}

#[global_allocator]
static ALLOCATOR: LibcAllocator = LibcAllocator;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

// A direct reference makes rustc retain the dependency's exported Wasm C API
// objects in the final static archive. Edge.js calls the standard unprefixed
// wasm_* symbols, not this anchor.
#[no_mangle]
pub unsafe extern "C" fn clawsembly_nested_wasm_force_link() {
    let engine = wasmi_c_api::wasm_engine_new();
    wasmi_c_api::wasm_engine_delete(engine);
}
