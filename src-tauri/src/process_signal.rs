//! Validated Unix signal targets: never allow broadcast or caller-group targets.
use std::io;

pub(crate) fn process_id(id: u32) -> io::Result<libc::pid_t> {
    i32::try_from(id)
        .ok()
        .filter(|id| *id > 1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid process ID"))
}

pub(crate) fn signal_process(id: u32, signal: i32) -> io::Result<()> {
    send(process_id(id)?, signal)
}

/// Only use for children spawned with process_group(0).
pub(crate) fn signal_group(id: u32, signal: i32) -> io::Result<()> {
    send(-process_id(id)?, signal)
}

fn send(target: libc::pid_t, signal: i32) -> io::Result<()> {
    // SAFETY: validation excludes 0, -1, and overflowing PID conversions.
    if unsafe { libc::kill(target, signal) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_broadcast_reserved_and_overflowing_targets() {
        for id in [0, 1, i32::MAX as u32 + 1, u32::MAX] {
            assert!(signal_process(id, 0).is_err());
            assert!(signal_group(id, 0).is_err());
        }
        assert_eq!(process_id(2).unwrap(), 2);
        assert_eq!(process_id(i32::MAX as u32).unwrap(), i32::MAX);
    }
}
