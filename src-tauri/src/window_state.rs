use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SavedWindowSize {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct MainWindowState {
    pub(crate) inner: Mutex<Option<SavedWindowSize>>,
    pub(crate) position: Mutex<Option<tauri::PhysicalPosition<i32>>>,
    pub(crate) position_tracking: AtomicBool,
}

impl MainWindowState {
    pub(crate) fn new(
        size: Option<SavedWindowSize>,
        position: Option<tauri::PhysicalPosition<i32>>,
    ) -> Self {
        Self {
            inner: Mutex::new(size),
            position: Mutex::new(position),
            position_tracking: AtomicBool::new(false),
        }
    }

    pub(crate) fn position(&self) -> Result<Option<tauri::PhysicalPosition<i32>>, String> {
        self.position
            .lock()
            .map(|position| *position)
            .map_err(|_| "Main window position status lock is poisoned".to_string())
    }

    pub(crate) fn replace_position(
        &self,
        position: tauri::PhysicalPosition<i32>,
    ) -> Result<(), String> {
        *self
            .position
            .lock()
            .map_err(|_| "Main window position status lock is poisoned".to_string())? =
            Some(position);
        Ok(())
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
