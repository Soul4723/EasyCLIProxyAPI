//! Spawn freshly written executables despite transient inherited Unix write handles.
use std::{io, process::{Child, Command}};

pub(crate) fn spawn(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        retry_executable_busy(|| command.spawn(), || {
            std::thread::sleep(std::time::Duration::from_millis(10));
        })
    }
    #[cfg(not(unix))]
    command.spawn()
}

#[cfg(unix)]
fn retry_executable_busy<T>(mut attempt: impl FnMut() -> io::Result<T>, mut pause: impl FnMut()) -> io::Result<T> {
    // A concurrent fork can inherit the copy/extraction writer until exec closes
    // its CLOEXEC fd. Retry only ETXTBSY, for at most 1 second (101 attempts).
    for retry in 0..=100 {
        match attempt() {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy && retry < 100 => pause(),
            result => return result,
        }
    }
    unreachable!()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn retries_busy_until_success() {
        let mut attempts = 0;
        let mut pauses = 0;
        let result = retry_executable_busy(|| {
            attempts += 1;
            if attempts < 3 { Err(io::Error::from_raw_os_error(libc::ETXTBSY)) } else { Ok(42) }
        }, || pauses += 1);
        assert_eq!(result.unwrap(), 42);
        assert_eq!((attempts, pauses), (3, 2));
    }

    #[test]
    fn busy_retries_are_bounded_and_other_errors_are_not_retried() {
        for (code, expected) in [(libc::ETXTBSY, 101), (libc::EACCES, 1), (libc::ENOENT, 1)] {
            let mut attempts = 0;
            let result: io::Result<()> = retry_executable_busy(|| {
                attempts += 1;
                Err(io::Error::from_raw_os_error(code))
            }, || {});
            assert_eq!(result.unwrap_err().raw_os_error(), Some(code));
            assert_eq!(attempts, expected);
        }
    }
}
