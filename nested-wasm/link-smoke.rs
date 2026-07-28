#![no_std]

use core::ffi::c_void;

unsafe extern "C" {
    fn wasm_engine_delete(engine: *mut c_void);
    fn wasm_engine_new() -> *mut c_void;
}

#[no_mangle]
pub unsafe extern "C" fn clawsembly_nested_link_probe() -> i32 {
    let engine = wasm_engine_new();
    if engine.is_null() {
        return 0;
    }
    wasm_engine_delete(engine);
    1
}
