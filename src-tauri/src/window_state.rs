use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SavedWindowSize {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct MainWindowSizeState {
    pub(crate) inner: Mutex<Option<SavedWindowSize>>,
}

impl MainWindowSizeState {
    pub(crate) fn new(size: Option<SavedWindowSize>) -> Self {
        Self {
            inner: Mutex::new(size),
        }
    }

    pub(crate) fn snapshot(&self) -> Result<Option<SavedWindowSize>, String> {
        self.inner
            .lock()
            .map(|size| *size)
            .map_err(|_| "Main window size status lock is poisoned".to_string())
    }

    pub(crate) fn replace(&self, size: SavedWindowSize) -> Result<(), String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "Main window size status lock is poisoned".to_string())?;
        *current = Some(size);
        Ok(())
    }
}
