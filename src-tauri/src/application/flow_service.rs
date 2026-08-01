use std::sync::Arc;

use crate::{
    application::ports::{FlowRepository, PortError},
    domain::Flow,
};

pub struct FlowService<R: FlowRepository + ?Sized> {
    repository: Arc<R>,
}

impl<R: FlowRepository + ?Sized> FlowService<R> {
    pub fn new(repository: Arc<R>) -> Self {
        Self { repository }
    }

    pub async fn save_flow(&self, flow: &Flow) -> Result<Flow, PortError> {
        self.repository.save_flow(flow).await?;
        self.repository
            .load_flow(&flow.id)
            .await?
            .ok_or_else(|| PortError::new("FLOW_NOT_FOUND", "flow could not be reloaded"))
    }

    pub async fn list_flows(&self) -> Result<Vec<Flow>, PortError> {
        self.repository.list_flows().await
    }

    pub async fn duplicate_flow(
        &self,
        flow_id: &str,
        duplicate_id: &str,
    ) -> Result<Flow, PortError> {
        if self.repository.load_flow(duplicate_id).await?.is_some() {
            return Err(PortError::new(
                "FLOW_ALREADY_EXISTS",
                "flow ID already exists",
            ));
        }
        let mut duplicate = self
            .repository
            .load_flow(flow_id)
            .await?
            .ok_or_else(|| PortError::new("FLOW_NOT_FOUND", "flow not found"))?;
        duplicate.id = duplicate_id.into();
        duplicate.name = format!("{} copy", duplicate.name);
        self.save_flow(&duplicate).await
    }
}
